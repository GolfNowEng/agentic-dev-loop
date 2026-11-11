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
import { buildPollJql, excludeKeysFromJql } from "../core/jql.ts";
import { append, makeCtx, nowIso, roleCapped, runsToday, workerState, type Ctx, type WorkerDeps, type WorkerIterationResult } from "./context.ts";
import { completePendingHandoffs } from "./handoff.ts";
import { enforceAttemptCap } from "./attempts.ts";
import { recordFlights, resumeNext } from "./recover.ts";
import {
  MIN_DEV_BUDGET_USD,
  WorkerPausedError,
  devBudget,
  nextDevCandidate,
  nextResearchCandidate,
  postPhaseBreach,
  researchBudget,
  runPhase,
} from "./cycle-steps.ts";

export type { WorkerDeps, WorkerIterationResult } from "./context.ts";
export { WorkerPausedError } from "./cycle-steps.ts";

const DEFAULT_RECENT_WINDOW_MS = 600_000;

export async function runWorkerIteration(deps: WorkerDeps): Promise<WorkerIterationResult> {
  const { state, first } = workerState(deps);
  const ctx = makeCtx(deps, state, await readIterations(deps.logPath));
  if (first) {
    for (const f of deps.session.orphanedInFlight) {
      ctx.log(`[worker] orphaned in-flight ${f.role} run on ${f.ticket} from a crashed session (${f.runDir}): recorded for resume`);
    }
  }
  try {
    return await iterate(ctx, first);
  } catch (err) {
    if (err instanceof WorkerPausedError) return { kind: "paused", reason: err.message };
    throw err;
  }
}

async function iterate(ctx: Ctx, first: boolean): Promise<WorkerIterationResult> {
  const { deps } = ctx;
  // Recently ended as of the iteration start (records this iteration appends, e.g. a
  // step-1 handoff-done, don't hide their own ticket from this iteration).
  const recent = recentlyEnded(ctx.records, deps.now(), deps.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS);

  // 0. RECOVER. First iteration: every adopted in-flight run becomes a durable record
  // (resume: <role>). Every iteration: resume one pending run of a role this process runs.
  const healed = first ? await recordFlights(ctx, ctx.state.flights) : null;
  const resumed = await resumeNext(ctx, (c, t, s) => researchThenDev(c, t, s, []), (c, t, s) => devOnly(c, t, s));
  if (resumed) return resumed;
  if (healed) return healed;

  // 1. Pending handoffs (not in research-only mode: there the handoff is left pending).
  if (ctx.roles.has("dev")) await completePendingHandoffs(ctx);

  // 2. EXCLUDE: recently ended (survives restarts; Jira index lag) ∪ attempt-capped.
  for (const k of recent) ctx.exclude.add(k);
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
): Promise<WorkerIterationResult> {
  const record = await append(ctx, ticket, started, outcome, phases, extra(syncErrors, detail));
  if (fatal) return { kind: "paused", reason: fatal, record };
  const last = phases.at(-1);
  const breach = last ? postPhaseBreach(ctx, last) : null;
  if (breach) return { kind: "paused", reason: breach, record };
  return { kind: "did", record };
}

/** A dev phase on a ticket that is already past research (resume, step-1 handoff, dev poll). */
export async function devOnly(ctx: Ctx, t: JiraTicket, started: string, syncErrors: string[] = []): Promise<WorkerIterationResult> {
  const run = await runPhase(ctx, "dev", t, devBudget(ctx));
  // In-flight couldn't be recorded: nothing ran, and the ticket is still in the dev poll (or its resume is still pending).
  if (run.entry === null) return { kind: "paused", reason: run.fatal };
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
  const research = r.entry;
  if (research.outcome !== "landed" || r.fatal) {
    return finish(ctx, t.key, started, research.outcome, [research], syncErrors, r.fatal);
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
  return finish(ctx, t.key, started, d.entry.outcome, [handed, d.entry], syncErrors, d.fatal);
}
