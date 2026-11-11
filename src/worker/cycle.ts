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
import { recoverOne } from "./recover.ts";
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
      ctx.log(`[worker] orphaned in-flight ${f.role} run on ${f.ticket} from a crashed session (${f.runDir}): will be resumed`);
    }
  }
  try {
    return await iterate(ctx);
  } catch (err) {
    if (err instanceof WorkerPausedError) return { kind: "paused", reason: err.message };
    throw err;
  }
}

async function iterate(ctx: Ctx): Promise<WorkerIterationResult> {
  const { deps } = ctx;

  // 0. RECOVER: one crashed in-flight run per iteration (the adopted one, then orphans).
  const f = ctx.state.recover.shift();
  if (f) return recoverOne(ctx, f, researchThenDev, devOnly);

  // 1. Pending handoffs (not in research-only mode: there the handoff is left pending).
  if (ctx.roles.has("dev")) await completePendingHandoffs(ctx);

  // 2. EXCLUDE: recently ended (survives restarts; Jira index lag) ∪ attempt-capped.
  for (const k of recentlyEnded(ctx.records, deps.now(), deps.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS)) ctx.exclude.add(k);
  await enforceAttemptCap(ctx);

  const enabled = [...ctx.roles];
  if (enabled.every((r) => roleCapped(ctx, r))) {
    return { kind: "paused", reason: capReason(ctx, enabled) };
  }

  // 3. DEV RESUME FIRST (no claim).
  if (ctx.roles.has("dev") && !roleCapped(ctx, "dev")) {
    const t = await nextDevCandidate(ctx);
    if (t) return devOnly(ctx, t, nowIso(ctx), []);
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
  const syncErrors: string[] = [];
  if (t.assignee === null) {
    try {
      await deps.jira.assignTicket(t.key, deps.assigneeAccountId);
    } catch (err) {
      syncErrors.push(errorMessage(err));
      ctx.log(`[worker] ${t.key}: assign failed (non-fatal): ${errorMessage(err)}`);
    }
  }
  return researchThenDev(ctx, t, started, [], syncErrors);
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

/** A dev phase on a ticket that is already past research (resume, step-1 handoff, crash recovery). */
export async function devOnly(ctx: Ctx, t: JiraTicket, started: string, prior: PhaseEntry[]): Promise<WorkerIterationResult> {
  const run = await runPhase(ctx, "dev", t, devBudget(ctx));
  return finish(ctx, t.key, started, run.entry.outcome, [...prior, run.entry], [], run.fatal);
}

/** Research (already claimed) -> ceiling check -> handoff -> dev on the same ticket. */
export async function researchThenDev(
  ctx: Ctx,
  t: JiraTicket,
  started: string,
  prior: PhaseEntry[],
  syncErrors: string[] = [],
): Promise<WorkerIterationResult> {
  const { deps } = ctx;
  const r = await runPhase(ctx, "research", t, researchBudget(ctx));
  const research = r.entry;
  if (research.outcome !== "landed" || r.fatal) {
    return finish(ctx, t.key, started, research.outcome, [...prior, research], syncErrors, r.fatal);
  }

  const breach = postPhaseBreach(ctx, research);
  if (breach) {
    const phases = [...prior, { ...research, handoff: "skipped-ceiling" as const }];
    const record = await append(ctx, t.key, started, "handoff-pending", phases, extra(syncErrors, "research landed; handoff skipped: ceiling breached"));
    return { kind: "paused", reason: breach, record };
  }

  if (!ctx.roles.has("dev")) {
    // Research-only (--phase research): the handoff is left pending for a dev-enabled worker.
    return finish(ctx, t.key, started, "landed", [...prior, research], syncErrors, undefined);
  }

  try {
    await deps.jira.swapLabel(t.key, ctx.research.triggerLabel, ctx.research.handoffLabel);
  } catch (err) {
    const message = errorMessage(err);
    ctx.log(`[worker] ${t.key}: handoff label swap failed (retried next iteration): ${message}`);
    const phases = [...prior, { ...research, handoff: "failed" as const }];
    return finish(ctx, t.key, started, "handoff-pending", phases, [...syncErrors, message], undefined, "research landed; the label handoff to dev failed");
  }
  const handed = { ...research, handoff: "done" as const };

  const budget = devBudget(ctx, research.cost_usd);
  if (roleCapped(ctx, "dev") || budget < MIN_DEV_BUDGET_USD) {
    // Handed off; the dev poll picks it up later (after the dev count resets / with a fresh budget).
    const why = budget < MIN_DEV_BUDGET_USD ? `dev deferred: $${budget.toFixed(2)} left of the per-ticket budget` : "dev deferred: dev maxRunsPerDay reached";
    ctx.log(`[worker] ${t.key}: ${why}`);
    return finish(ctx, t.key, started, "landed", [...prior, handed], syncErrors, undefined, why);
  }

  const devTicket: JiraTicket = { ...t, status: ctx.research.claimStatus.to, labels: [ctx.dev.triggerLabel] };
  const d = await runPhase(ctx, "dev", devTicket, budget);
  return finish(ctx, t.key, started, d.entry.outcome, [...prior, handed, d.entry], syncErrors, d.fatal);
}
