// The worker cycle (spec §6.3; algorithm steps 0-5 in the Task 13 brief).
// One call = one iteration: it recovers a crashed run, completes pending
// handoffs, applies the attempt cap, then works at most one ticket (dev
// resume first, else claim + research, handing off straight into dev on the
// same ticket with no human gate), writing one record per ticket iteration.
//
// Never throws for a per-ticket failure. Worker-wide conditions come back as
// `paused` (a ceiling breach, a Jira auth failure on the poll, a lost session
// lock), always after the record is appended. It may still throw for a
// config error (e.g. buildPollJql rejecting the assignee id) or a failed
// log write.

import type { JiraTicket } from "../core/jira-client.ts";
import type { IterationOutcome, IterationRecord, PhaseEntry } from "../core/iteration-log.ts";
import { readIterations, recentlyEnded } from "../core/iteration-log.ts";
import { errorMessage } from "../core/run-skill.ts";
import { redactSensitive } from "../core/redact.ts";
import { buildPollJql, excludeKeysFromJql } from "../core/jql.ts";
import { append, latestRecord, makeCtx, nowIso, roleCapped, runsToday, workerState, type Ctx, type WorkerDeps, type WorkerIterationResult } from "./context.ts";
import { completePendingHandoffs } from "./handoff.ts";
import { enforceAttemptCap } from "./attempts.ts";
import { isDroppedResume, recordFlights, resumeNext } from "./recover.ts";
import {
  MIN_DEV_BUDGET_USD,
  WorkerPausedError,
  devBudget,
  nextDevCandidate,
  nextResearchCandidate,
  postPhaseBreach,
  researchBudget,
  runPhase,
  type PhaseParked,
} from "./cycle-steps.ts";

export type { WorkerDeps, WorkerIterationResult } from "./context.ts";
export { WorkerPausedError } from "./cycle-steps.ts";

const DEFAULT_RECENT_WINDOW_MS = 600_000;

/**
 * Write every in-flight run the session adopted (inFlight, then orphans) to
 * the log with `resume: <role>`, then clear the lock's inFlight: from here the
 * log owns the resume. Idempotent; runWorkerIteration calls it if the caller
 * didn't. main.ts calls it right after acquiring the session, before any
 * other work, and only then lets a signal release the lock.
 */
export async function recordAdoptedFlights(deps: WorkerDeps): Promise<void> {
  const { state } = workerState(deps);
  if (state.flightsRecorded) return;
  const ctx = makeCtx(deps, state, await readIterations(deps.logPath));
  await recordFlightsOnce(ctx);
}

async function recordFlightsOnce(ctx: Ctx): Promise<void> {
  const { state, deps } = ctx;
  if (state.flightsRecorded) return;
  for (const f of deps.session.orphanedInFlight) {
    ctx.log(`[worker] orphaned in-flight ${f.role} run on ${f.ticket} from a crashed session (${f.runDir}): recorded for resume`);
  }
  state.healed = await recordFlights(ctx, state.flights);
  state.flightsRecorded = true;
  if (deps.session.inFlight !== null) {
    try {
      await deps.session.setInFlight(null);
    } catch (err) {
      // Harmless: the flight is in the log; re-adopting it later is idempotent.
      ctx.log(`[worker] could not clear the adopted in-flight record from the lock: ${errorMessage(err)}`);
    }
  }
}

export async function runWorkerIteration(deps: WorkerDeps): Promise<WorkerIterationResult> {
  const { state } = workerState(deps);
  const ctx = makeCtx(deps, state, await readIterations(deps.logPath));
  try {
    return await iterate(ctx);
  } catch (err) {
    if (err instanceof WorkerPausedError) return { kind: "paused", reason: err.message };
    throw err;
  }
}

async function iterate(ctx: Ctx): Promise<WorkerIterationResult> {
  const { deps } = ctx;
  // Recently ended as of the iteration start (records this iteration appends, e.g. a
  // step-1 handoff-done, don't hide their own ticket from this iteration).
  const recent = recentlyEnded(ctx.records, deps.now(), deps.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS);

  // 0. RECOVER. First iteration: every adopted in-flight run becomes a durable record
  // (resume: <role>). Every iteration: resume one pending run of a role this process runs.
  await recordFlightsOnce(ctx);
  const healed = ctx.state.healed;
  ctx.state.healed = null;
  const resumed = await resumeNext(ctx, (c, t, s) => researchThenDev(c, t, s, []), (c, t, s) => devOnly(c, t, s));
  if (resumed) return resumed;
  // A dropped resume is bookkeeping (its record is written): carry on to the poll.
  if (healed && !isDroppedResume(healed)) return healed;

  // 1. Pending handoffs (not in research-only mode: there the handoff is left pending).
  if (ctx.roles.has("dev")) await completePendingHandoffs(ctx);

  // 2. EXCLUDE: recently ended (survives restarts; Jira index lag) ∪ parked ∪ attempt-capped.
  for (const k of recent) ctx.exclude.add(k);
  for (const k of new Set(ctx.records.map((r) => r.ticket))) {
    if (latestRecord(ctx.records, k)?.outcome === "parked") ctx.exclude.add(k);
  }
  await enforceAttemptCap(ctx);

  const enabled = [...ctx.roles];
  if (enabled.every((r) => roleCapped(ctx, r))) {
    return { kind: "paused", reason: capReason(ctx, enabled) };
  }

  // 3. DEV RESUME FIRST (no claim; assign if unassigned, as v1 did).
  if (ctx.roles.has("dev") && !roleCapped(ctx, "dev")) {
    const c = await nextDevCandidate(ctx);
    if (c) {
      const syncErrors = c.polled ? await assignIfUnassigned(ctx, c.ticket) : [];
      return devOnly(ctx, c.ticket, nowIso(ctx), syncErrors);
    }
  }

  // 4. RESEARCH.
  if (!ctx.roles.has("research")) return { kind: "idle" };
  if (roleCapped(ctx, "research")) {
    // Dev had nothing to do; research has work but is capped -> pause rather than spin.
    const candidate = await nextResearchCandidateWithoutClaim(ctx);
    return candidate ? { kind: "paused", reason: capReason(ctx, ["research"]) } : { kind: "idle" };
  }
  const t = await nextResearchCandidate(ctx);
  if (!t) return { kind: "idle" };
  const started = nowIso(ctx);
  const syncErrors = await assignIfUnassigned(ctx, t);
  return researchThenDev(ctx, t, started, syncErrors);
}

/** Non-fatal assign-if-unassigned; returns the error, if any, for the record's jira_sync_error. */
async function assignIfUnassigned(ctx: Ctx, t: JiraTicket): Promise<string[]> {
  if (t.assignee !== null) return [];
  try {
    await ctx.deps.jira.assignTicket(t.key, ctx.deps.assigneeAccountId);
    return [];
  } catch (err) {
    ctx.log(`[worker] ${t.key}: assign failed (non-fatal): ${errorMessage(err)}`);
    return [errorMessage(err)];
  }
}

function capReason(ctx: Ctx, roles: Array<"research" | "dev">): string {
  return roles
    .map((r) => `${r} maxRunsPerDay reached (${runsToday(ctx, r)}/${(r === "research" ? ctx.research : ctx.dev).limits.maxRunsPerDay})`)
    .join("; ");
}

/** Whether research has a raw candidate at all (used only to decide paused vs idle when research is capped). */
async function nextResearchCandidateWithoutClaim(ctx: Ctx): Promise<boolean> {
  const jql = excludeKeysFromJql(buildPollJql(ctx.research, { assigneeAccountId: ctx.deps.assigneeAccountId }), [...ctx.exclude]);
  try {
    return (await ctx.deps.jira.pollOldestMatching(jql)) !== null;
  } catch (err) {
    ctx.log(`[worker] research poll failed: ${errorMessage(err)}`);
    return false;
  }
}

function extra(syncErrors: string[], detail?: string): Partial<Pick<IterationRecord, "detail" | "jira_sync_error">> {
  return {
    ...(detail !== undefined ? { detail } : {}),
    ...(syncErrors.length > 0 ? { jira_sync_error: syncErrors.join("; ") } : {}),
  };
}

/** Append, then turn a lost lock or a ceiling breach on `last` into paused (record first, step 5). */
async function finish(
  ctx: Ctx,
  ticket: string,
  started: string,
  outcome: IterationOutcome,
  phases: PhaseEntry[],
  syncErrors: string[],
  fatal: string | undefined,
  detail?: string,
  resume?: "research" | "dev",
): Promise<WorkerIterationResult> {
  const record = await append(ctx, ticket, started, outcome, phases, { ...extra(syncErrors, detail), ...(resume ? { resume } : {}) });
  if (fatal) return { kind: "paused", reason: fatal, record };
  const last = phases.at(-1);
  const breach = last ? postPhaseBreach(ctx, last) : null;
  if (breach) return { kind: "paused", reason: breach, record };
  return { kind: "did", record };
}

/**
 * A run the sandbox refused: one "parked" record (resume set, not an attempt,
 * no Jira write; `prior` keeps a landed research), a notification, and the
 * loop carries on. A lost session lock, or the refused run breaching its
 * role's cost/duration ceiling (its cost is real but not in `phases`), still
 * pauses, after the record, as finish() does. So does an all-infra refusal
 * (the sandbox itself failed: daemon down, prepare timed out): it is not
 * ticket-specific, so carrying on would park ticket after ticket.
 */
async function park(
  ctx: Ctx,
  t: JiraTicket,
  started: string,
  role: "research" | "dev",
  parked: PhaseParked,
  prior: PhaseEntry[],
  syncErrors: string[],
  fatal: string | undefined,
): Promise<WorkerIterationResult> {
  const { denied, approveHint, allInfra, cost_usd, run_dir, started: runStarted, ended: runEnded, sandbox } = parked;
  const record = await append(ctx, t.key, started, "parked", prior, {
    ...extra(syncErrors, `sandbox refused: ${denied.map((d) => `${d.kind} ${d.target}`).join(", ")}`),
    resume: role,
    parked: {
      role,
      failure_category: "sandbox_denied",
      denied,
      ...(approveHint !== undefined ? { approveHint } : {}),
      cost_usd,
      run_dir,
      ...(sandbox !== undefined ? { sandbox } : {}),
    },
  });
  ctx.deps.notify?.(`dev-loop: ${t.key} parked`, `sandbox refused ${denied.map((d) => d.target).join(", ")}; run npm run sandbox:approvals`);
  if (fatal) return { kind: "paused", reason: fatal, record };
  if (allInfra) {
    // approveHint is the (already redacted) failure message for a prepare failure; redact again, it is free text.
    const what = approveHint !== undefined ? redactSensitive(approveHint) : denied.map((d) => `infra ${d.target}`).join(", ");
    return {
      kind: "paused",
      reason: `sandbox infrastructure failed: ${what} (${t.key}); fix the sandbox, then run npm run sandbox:approvals -- --clear=${t.key}`,
      record,
    };
  }
  const breach = postPhaseBreach(ctx, { role, cost_usd, started: runStarted, ended: runEnded });
  if (breach) return { kind: "paused", reason: breach, record };
  return { kind: "did", record };
}

/** A dev phase on a ticket that is already past research (resume, step-1 handoff, dev poll). */
export async function devOnly(ctx: Ctx, t: JiraTicket, started: string, syncErrors: string[] = []): Promise<WorkerIterationResult> {
  const run = await runPhase(ctx, "dev", t, devBudget(ctx));
  // In-flight couldn't be recorded: nothing ran, and the ticket is still in the dev poll (or its resume is still pending).
  if (run.entry === null) return { kind: "paused", reason: run.fatal };
  if (run.parked) return park(ctx, t, started, "dev", run.parked, [], syncErrors, run.fatal);
  return finish(ctx, t.key, started, run.entry.outcome, [run.entry], syncErrors, run.fatal);
}

/** Research (already claimed, or resumed) -> ceiling check -> handoff -> dev on the same ticket. */
export async function researchThenDev(
  ctx: Ctx,
  t: JiraTicket,
  started: string,
  syncErrors: string[] = [],
): Promise<WorkerIterationResult> {
  const { deps } = ctx;
  const r = await runPhase(ctx, "research", t, researchBudget(ctx));
  if (r.entry === null) {
    // The claim already moved the ticket out of the research poll's status: record it with a
    // pending resume so the next start runs research on it without a claim.
    const record = await append(ctx, t.key, started, "error", [], {
      resume: "research",
      detail: `claimed, but the research phase never started: ${r.fatal}`,
      ...(syncErrors.length > 0 ? { jira_sync_error: syncErrors.join("; ") } : {}),
    });
    return { kind: "paused", reason: r.fatal, record };
  }
  if (r.parked) return park(ctx, t, started, "research", r.parked, [], syncErrors, r.fatal);
  const research = r.entry;
  if (research.outcome !== "landed" || r.fatal) {
    // Ruling 20: an error/killed research leaves the ticket claimed (In Progress), out of
    // the research poll, so the record carries resume:"research" and step 0 retries it
    // until the attempt cap (step 2) blocks it. A dev error needs nothing: the dev poll
    // (dev label, status not bounced/prOpen) re-finds it.
    const retry = research.outcome === "error" || research.outcome === "killed";
    return finish(ctx, t.key, started, research.outcome, [research], syncErrors, r.fatal, undefined, retry ? "research" : undefined);
  }

  const breach = postPhaseBreach(ctx, research);
  if (breach) {
    const phases = [{ ...research, handoff: "skipped-ceiling" as const }];
    const record = await append(ctx, t.key, started, "handoff-pending", phases, extra(syncErrors, "research landed; handoff skipped: ceiling breached"));
    return { kind: "paused", reason: breach, record };
  }

  if (!ctx.roles.has("dev")) {
    // Research-only (--phase research): the handoff is left pending for a dev-enabled worker.
    return finish(ctx, t.key, started, "landed", [research], syncErrors, undefined);
  }

  try {
    await deps.jira.swapLabel(t.key, ctx.research.triggerLabel, ctx.research.handoffLabel);
  } catch (err) {
    const message = errorMessage(err);
    ctx.log(`[worker] ${t.key}: handoff label swap failed (retried next iteration): ${message}`);
    const phases = [{ ...research, handoff: "failed" as const }];
    return finish(ctx, t.key, started, "handoff-pending", phases, [...syncErrors, message], undefined, "research landed; the label handoff to dev failed");
  }
  const handed = { ...research, handoff: "done" as const };

  const budget = devBudget(ctx, research.cost_usd);
  if (roleCapped(ctx, "dev") || budget < MIN_DEV_BUDGET_USD) {
    // Handed off; the dev poll picks it up later (after the dev count resets / with a fresh budget).
    const why = budget < MIN_DEV_BUDGET_USD ? `dev deferred: $${budget.toFixed(2)} left of the per-ticket budget` : "dev deferred: dev maxRunsPerDay reached";
    ctx.log(`[worker] ${t.key}: ${why}`);
    return finish(ctx, t.key, started, "landed", [handed], syncErrors, undefined, why);
  }

  const devTicket: JiraTicket = { ...t, status: ctx.research.claimStatus.to, labels: [ctx.dev.triggerLabel] };
  const d = await runPhase(ctx, "dev", devTicket, budget);
  if (d.entry === null) {
    // Research and its cost are recorded first; the handed-off ticket is in the dev poll.
    return finish(ctx, t.key, started, "landed", [handed], syncErrors, d.fatal, "research landed and handed off; dev not started (session lock)");
  }
  if (d.parked) return park(ctx, t, started, "dev", d.parked, [handed], syncErrors, d.fatal);
  return finish(ctx, t.key, started, d.entry.outcome, [handed, d.entry], syncErrors, d.fatal);
}
