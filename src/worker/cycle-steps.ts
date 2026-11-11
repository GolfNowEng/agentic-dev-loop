// The building blocks of one worker iteration: polling a role's next
// candidate (key validation, landed guards, blocker gate, skip budget),
// running one phase with in-flight bookkeeping, the Ruling 16 budgets and the
// post-phase ceiling check. cycle.ts sequences them.

import type { JiraTicket } from "../core/jira-client.ts";
import type { Role } from "../core/types.ts";
import type { PhaseEntry } from "../core/iteration-log.ts";
import { hasLandedPhase, lastSkipBlockers } from "../core/iteration-log.ts";
import { buildPollJql, excludeKeysFromJql } from "../core/jql.ts";
import { gateTicket } from "../core/blocker-gate.ts";
import { checkCeilings } from "../core/ceilings.ts";
import { TICKET_KEY, runIdNow, v2RunDir } from "../core/paths.ts";
import { durationMin, errorMessage } from "../core/run-skill.ts";
import { runResearchPhase } from "../roles/research/phase.ts";
import { runDevPhase } from "../roles/dev/phase.ts";
import { append, MAX_SKIPS, nowIso, type Ctx } from "./context.ts";

/** A Jira error that would fail every ticket (auth/permission): the worker pauses. */
export class WorkerPausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerPausedError";
  }
}

const AUTH_ERROR = /->\s*(401|403)\b/;

/** Poll; an auth failure pauses the worker, any other poll failure ends the iteration idle (retried next poll). */
async function poll(ctx: Ctx, role: Role): Promise<JiraTicket | null | "error"> {
  const view = role === "research" ? ctx.research : ctx.dev;
  const jql = excludeKeysFromJql(buildPollJql(view, { assigneeAccountId: ctx.deps.assigneeAccountId }), [...ctx.exclude]);
  try {
    return await ctx.deps.jira.pollOldestMatching(jql);
  } catch (err) {
    const message = errorMessage(err);
    if (AUTH_ERROR.test(message)) throw new WorkerPausedError(`Jira ${role} poll failed (auth): ${message}`);
    ctx.log(`[worker] ${role} poll failed, will retry next iteration: ${message}`);
    return "error";
  }
}

function skip(ctx: Ctx, key: string, why: string): void {
  ctx.exclude.add(key);
  ctx.skips++;
  ctx.log(`[worker] ${key}: skipped, ${why}`);
}

/** Why a dev candidate must not run (its recorded landed PR is merged, still open, or unreadable), or null. */
export async function landedSkipReason(ctx: Ctx, key: string): Promise<string | null> {
  const prUrl = await ctx.deps.gate.findLandedPrUrl(key);
  if (!prUrl) return null;
  try {
    const status = JSON.parse(await ctx.deps.gate.execGhPrView(prUrl)) as { state?: string; mergedAt?: string | null };
    if (status.mergedAt) return `already landed, PR merged (${prUrl})`;
    if (status.state === "OPEN") return `already landed, PR still open (${prUrl})`;
    return null;
  } catch (err) {
    return `already landed (${prUrl}) but its PR state could not be read: ${errorMessage(err)}`;
  }
}

/** Blocker gate; appends "skipped-blocked" only when the blocker set changed since the last skip. True = passes. */
async function gate(ctx: Ctx, key: string): Promise<boolean> {
  const { config } = ctx.deps;
  const g = await gateTicket(key, {
    ...ctx.deps.gate,
    repo: config.github.repo,
    defaultBranch: config.targetRepo.defaultBranch,
    jira: ctx.deps.jira,
  });
  if (g.pass) return true;
  const prev = lastSkipBlockers(ctx.records, key);
  const same = prev !== null && prev.length === g.blockedBy.length && prev.every((k, i) => k === g.blockedBy[i]);
  if (!same) {
    await append(ctx, key, nowIso(ctx), "skipped-blocked", [], { blocked_by: g.blockedBy, detail: g.reasons.join("; ") });
  }
  skip(ctx, key, `blocked: ${g.reasons.join("; ")}`);
  return false;
}

/** A polled key that fails TICKET_KEY: logged once per process; the role's poll stops this iteration (it can't be excluded by key). */
function badKey(ctx: Ctx, key: unknown): void {
  const k = String(key).slice(0, 60);
  if (!ctx.state.badKeys.has(k)) {
    ctx.state.badKeys.add(k);
    ctx.log(`[worker] invalid ticket key from the poll, skipped: ${JSON.stringify(k)}`);
  }
}

/** Step 3's candidate: step-1 handoffs first, then the dev poll; landed guard + gate. No claim. */
export async function nextDevCandidate(ctx: Ctx): Promise<JiraTicket | null> {
  const queue = ctx.handedOff.filter((k) => !ctx.exclude.has(k));
  for (;;) {
    if (ctx.skips >= MAX_SKIPS) return null;
    let t: JiraTicket | null;
    const handed = queue.shift();
    if (handed !== undefined) {
      if (ctx.exclude.has(handed)) continue;
      t = { key: handed, status: ctx.research.claimStatus.to, assignee: null, labels: [ctx.dev.triggerLabel] };
    } else {
      const p = await poll(ctx, "dev");
      if (p === "error" || p === null) return null;
      t = p;
    }
    if (typeof t.key !== "string" || !TICKET_KEY.test(t.key)) {
      badKey(ctx, t.key);
      return null;
    }
    const landed = await landedSkipReason(ctx, t.key);
    if (landed) {
      skip(ctx, t.key, landed);
      continue;
    }
    if (!(await gate(ctx, t.key))) continue;
    return t;
  }
}

/** Step 4's candidate: research poll, never-re-refine guard, gate, then claim. */
export async function nextResearchCandidate(ctx: Ctx): Promise<JiraTicket | null> {
  for (;;) {
    if (ctx.skips >= MAX_SKIPS) return null;
    const t = await poll(ctx, "research");
    if (t === "error" || t === null) return null;
    if (typeof t.key !== "string" || !TICKET_KEY.test(t.key)) {
      badKey(ctx, t.key);
      return null;
    }
    if (hasLandedPhase(ctx.records, t.key, "research") || (await ctx.deps.hasLandedResearchV1?.(t.key))) {
      skip(ctx, t.key, "already refined (a landed research run is recorded); never re-refined");
      continue;
    }
    if (!(await gate(ctx, t.key))) continue;
    let claimed: boolean;
    try {
      claimed = await ctx.deps.jira.claimTicket(t.key, ctx.research.claimStatus.from, ctx.research.claimStatus.to);
    } catch (err) {
      await append(ctx, t.key, nowIso(ctx), "claim-error", [], { detail: `claim failed: ${errorMessage(err)}` });
      skip(ctx, t.key, `claim threw: ${errorMessage(err)}`);
      continue;
    }
    if (!claimed) {
      skip(ctx, t.key, "claim lost a race");
      continue;
    }
    return t;
  }
}

// ---- budgets (Ruling 16) ----

export function researchBudget(ctx: Ctx): number {
  return Math.min(ctx.research.limits.maxCostPerRunUsd, ctx.deps.config.ceilings.maxCostPerTicketUsd);
}

/** Dev budget after `spentUsd` this iteration (0 for a dev-only iteration). Below 1: don't start dev. */
export function devBudget(ctx: Ctx, spentUsd = 0): number {
  return Math.min(ctx.dev.limits.maxCostPerRunUsd, ctx.deps.config.ceilings.maxCostPerTicketUsd - spentUsd);
}

export const MIN_DEV_BUDGET_USD = 1;

// ---- running a phase ----

export interface PhaseRun {
  entry: PhaseEntry;
  /** setInFlight(null) failed: the session lock is gone. Append the record, then pause. */
  fatal?: string;
}

/** setInFlight(role) -> run the phase -> setInFlight(null). A failure to set in-flight before the run throws (nothing to lose yet). */
export async function runPhase(ctx: Ctx, role: Role, ticket: JiraTicket, maxBudgetUsd: number): Promise<PhaseRun> {
  const { deps } = ctx;
  const since = nowIso(ctx);
  const runDir = v2RunDir(deps.slug, deps.session.name, ticket.key, role, runIdNow(deps.now()));
  await deps.session.setInFlight({ ticket: ticket.key, role, runDir, since });
  ctx.log(`[worker] ${ticket.key}: ${role} phase starting (budget $${maxBudgetUsd})`);
  const entry =
    role === "research"
      ? await runResearchPhase(ticket, { jira: deps.jira, view: ctx.research, runSkill: deps.runSkill, runDir, maxBudgetUsd, now: deps.now })
      : await runDevPhase(ticket, {
          jira: deps.jira,
          github: deps.github,
          view: ctx.dev,
          runSkill: deps.runSkill,
          runDir,
          maxBudgetUsd,
          session: deps.session.name,
          now: deps.now,
        });
  ctx.log(`[worker] ${ticket.key}: ${role} ${entry.outcome}: ${entry.detail}`);
  try {
    await deps.session.setInFlight(null);
    return { entry };
  } catch (err) {
    return { entry, fatal: `could not clear the session's in-flight record: ${errorMessage(err)}` };
  }
}

/**
 * Post-phase ceilings: cost and duration of this run against its role's
 * limits. runs/day is checked before a role starts (per role), not here, so
 * one role reaching its cap never stops the other role's work.
 */
export function postPhaseBreach(ctx: Ctx, entry: PhaseEntry): string | null {
  const view = entry.role === "research" ? ctx.research : ctx.dev;
  const c = checkCeilings({
    runsToday: 0,
    runCostUsd: entry.cost_usd,
    runDurationMin: durationMin(entry.started, entry.ended),
    limits: view.limits,
  });
  return c.breached ? `${entry.role}: ${c.detail}` : null;
}
