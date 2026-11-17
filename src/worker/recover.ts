// Cycle step 0: resume phase runs lost when a previous process stopped
// mid-phase. Two parts:
//
// recordFlights (first iteration of a process): every in-flight record the
// session adopted (`inFlight`, then each `orphanedInFlight`) becomes a
// durable record in the shared v2 log before anything is resumed, with
// `resume: <role>`:
//   - crashed: outcome "error" with one `error` phase (agent_error,
//     "in-flight ... lost"), so it counts toward maxAttemptsPerTicket;
//   - interrupted (SIGINT/SIGTERM, `interrupted: true` in the lock): outcome
//     "interrupted", no phase, so it is not a failed attempt;
//   - a dev flight with an open PR, in a process that runs dev: self-heal
//     instead (Code Review with the PR-link QA stub, no rebuild), recorded as
//     "skipped-pr-exists" with a landed dev phase carrying the PR, which
//     resets failedAttempts and teaches findLandedPrUrlAcross the PR.
// Every self-heal or resume first re-reads the live Jira status. Only
// `claimStatus.to` proceeds as above, except for a dev resume (Ruling 51):
// at `statusNames.prOpen` (Code Review) the dev run already landed (a signal
// or crash hit after runDevPhase moved the ticket), so an open PR gets the
// same skipped-pr-exists record without the Jira transition, and no open PR
// (merged, closed, lookup failed) is resume-dropped; dev is never re-run
// from Code Review. Any other status is resume-dropped. Research: only
// `claimStatus.to`.
// The log, not the lock, carries the resume because every --phase process
// of a project shares the session dir (and auto-names dev-1): a --phase dev
// start can adopt a --phase research crash. Keeping it in the log lets the
// process that runs that role find it, whichever session adopted it.
//
// resumeNext (every iteration): the first ticket whose latest record has
// `resume` set to a role this process runs, and is below the attempt cap, is
// re-run without a claim. Its new record (no `resume`) resolves it. A
// ticket at the cap is left to step 2, which blocks it.

import type { JiraTicket } from "../core/jira-client.ts";
import type { InFlight } from "../core/session.ts";
import type { PhaseEntry } from "../core/iteration-log.ts";
import { failedAttempts } from "../core/iteration-log.ts";
import type { Role } from "../core/types.ts";
import { errorMessage } from "../core/run-skill.ts";
import { buildCodeReviewFields, buildPrLinkQaNotesAdf } from "../roles/dev/code-review.ts";
import { append, crashEntry, knownTicket, latestRecord, nowIso, roleCapped, type Ctx, type WorkerIterationResult } from "./context.ts";

type Runner = (ctx: Ctx, t: JiraTicket, started: string) => Promise<WorkerIterationResult>;

const flightTag = (f: InFlight): string => `in-flight ${f.role} run ${f.runDir} (since ${f.since})`;

/**
 * Open PR for a dev resume, or null. A lookup failure is null: at In Progress
 * that re-runs dev rather than guess; at Code Review it drops the resume.
 */
async function openPr(ctx: Ctx, ticket: string): Promise<string | null> {
  try {
    return await ctx.deps.findOpenPrUrl(ticket);
  } catch (err) {
    ctx.log(`[worker] ${ticket}: open-PR lookup failed (treated as no open PR): ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Self-heal a dev ticket whose PR is already open: one resolved record. With
 * `transition`, the ticket is moved to Code Review first; without it (Ruling
 * 51) it is already there and Jira is not touched.
 */
async function selfHeal(
  ctx: Ctx,
  ticket: string,
  pr: string,
  runDir: string,
  since: string,
  transition: boolean,
): Promise<WorkerIterationResult> {
  const prOpen = ctx.dev.statusNames.prOpen;
  const errors: string[] = [];
  if (transition) {
    try {
      await ctx.deps.jira.transitionStatus(ticket, prOpen, buildCodeReviewFields(ctx.dev, buildPrLinkQaNotesAdf(pr)));
    } catch (err) {
      errors.push(errorMessage(err));
    }
  }
  const entry: PhaseEntry = {
    role: "dev",
    skill: "ticket-to-pr",
    skill_version: "",
    model: "",
    started: since,
    ended: nowIso(ctx),
    outcome: "landed",
    phase_reached: "pr",
    cost_usd: 0,
    tokens: { in: 0, out: 0 },
    failure_category: null,
    detail: `self-heal: existing PR ${pr}; no rebuild`,
    pr,
    run_dir: runDir,
  };
  const record = await append(ctx, ticket, nowIso(ctx), "skipped-pr-exists", [entry], {
    detail: transition
      ? `PR already open (${pr}); moved to ${prOpen} without a rebuild`
      : `PR already open (${pr}); already in ${prOpen}, no transition, no rebuild`,
    ...(errors.length > 0 ? { jira_sync_error: errors.join("; ") } : {}),
  });
  ctx.log(`[worker] ${ticket}: dev resume found an open PR (${pr}); ${transition ? `self-healed to ${prOpen}` : `already in ${prOpen}, recorded without a transition`}`);
  return { kind: "did", record };
}

/** A phase-less resume-dropped record (not an attempt, no `resume`: resolves the pending resume). */
async function dropResume(ctx: Ctx, ticket: string, detail: string): Promise<WorkerIterationResult> {
  const record = await append(ctx, ticket, nowIso(ctx), "resume-dropped", [], { detail });
  ctx.log(`[worker] ${ticket}: ${record.detail}`);
  return { kind: "did", record };
}

/**
 * A dev resume whose ticket is at Code Review (Ruling 51): the dev run had
 * landed. An open PR is recorded skipped-pr-exists without a transition;
 * none (merged, closed, lookup failed) drops the resume. Dev is never re-run.
 */
async function resolveAtCodeReview(ctx: Ctx, ticket: string, runDir: string, since: string, suffix: string): Promise<WorkerIterationResult> {
  const pr = await openPr(ctx, ticket);
  if (pr) return selfHeal(ctx, ticket, pr, runDir, since, false);
  return dropResume(
    ctx,
    ticket,
    `resume of the dev phase dropped: status is "${ctx.dev.statusNames.prOpen}" (Code Review with no open PR: merged, closed or lookup failed); dev is not re-run${suffix}`,
  );
}

/** First iteration: make every adopted flight durable in the log (idempotent per run dir). Returns the last self-heal, if any. */
export async function recordFlights(ctx: Ctx, flights: InFlight[]): Promise<WorkerIterationResult | null> {
  let healed: WorkerIterationResult | null = null;
  for (const f of flights) {
    const tag = flightTag(f);
    if (ctx.records.some((r) => r.ticket === f.ticket && r.resume === f.role && (r.detail ?? "").includes(tag))) continue;
    if (f.role === "dev" && ctx.roles.has("dev") && !f.interrupted) {
      // Same status gate as resumeNext: a moved ticket is not self-healed back to Code Review.
      // A failed lookup falls through to the normal flight record, so resumeNext re-checks it.
      let status: string | null = null;
      try {
        status = await ctx.deps.jira.getStatus(f.ticket);
      } catch (err) {
        ctx.log(`[worker] ${f.ticket}: status lookup failed, recording the flight for a later resume: ${errorMessage(err)}`);
      }
      if (status !== null && status === ctx.dev.statusNames.prOpen) {
        healed = await resolveAtCodeReview(ctx, f.ticket, f.runDir, f.since, ` (${tag})`);
        continue;
      }
      if (status !== null && status !== ctx.research.claimStatus.to) {
        healed = await dropResume(ctx, f.ticket, `resume of the dev phase dropped: status is now "${status}", not "${ctx.research.claimStatus.to}" (${tag})`);
        continue;
      }
      const pr = status === null ? null : await openPr(ctx, f.ticket);
      if (pr) {
        healed = await selfHeal(ctx, f.ticket, pr, f.runDir, f.since, true);
        continue;
      }
    }
    if (f.interrupted) {
      await append(ctx, f.ticket, nowIso(ctx), "interrupted", [], { resume: f.role, detail: `${tag} was interrupted (signal); to resume` });
    } else {
      const lost = crashEntry(ctx, f, `${tag} lost: its process died (crashed session); to resume`);
      await append(ctx, f.ticket, nowIso(ctx), "error", [lost], { resume: f.role, detail: `orphaned ${tag} from a crashed session` });
    }
    ctx.log(`[worker] ${f.ticket}: recorded ${f.interrupted ? "interrupted" : "crashed"} ${tag}${ctx.roles.has(f.role) ? "" : ` (left for a process that runs ${f.role})`}`);
  }
  return healed;
}

/** Tickets with a pending resume for a role this process runs, below the attempt cap, in log order. */
export function pendingResumes(ctx: Ctx): Array<{ ticket: string; role: Role; runDir: string; since: string }> {
  const out: Array<{ ticket: string; role: Role; runDir: string; since: string }> = [];
  const seen = new Set<string>();
  const cap = ctx.deps.config.ceilings.maxAttemptsPerTicket;
  for (const r of ctx.records) {
    if (seen.has(r.ticket)) continue;
    seen.add(r.ticket);
    const latest = latestRecord(ctx.records, r.ticket);
    const role = latest?.resume;
    if (!latest || !role || !ctx.roles.has(role)) continue;
    if (latest.outcome === "parked") continue; // held until sandbox:approvals --clear writes "unparked"
    if (failedAttempts(ctx.records, r.ticket, role) >= cap) continue;
    if (roleCapped(ctx, role)) continue; // maxRunsPerDay applies to resumes like to polls
    out.push({ ticket: r.ticket, role, runDir: latest.phases[0]?.run_dir ?? "", since: latest.phases[0]?.started ?? latest.started });
  }
  return out;
}

/** Resume one pending run (dev: self-heal if a PR is open now), or null when there is none. */
/** True for a resume-dropped result: bookkeeping only (no run, no Jira or git write), so the iteration goes on. */
export function isDroppedResume(r: WorkerIterationResult | null): boolean {
  return r !== null && r.kind === "did" && r.record.outcome === "resume-dropped";
}

/**
 * Resume the first pending run whose ticket is still claimed. A dropped
 * resume is resolved and the next one is tried, so a stale resume never
 * uses up the iteration (`--once` would otherwise exit without polling).
 */
export async function resumeNext(ctx: Ctx, researchThenDev: Runner, devOnly: Runner): Promise<WorkerIterationResult | null> {
  // Each drop appends a record that resolves its resume, so pendingResumes shrinks; the bound is a guard.
  for (let i = 0; i < 1000; i++) {
    const r = await resumeOne(ctx, researchThenDev, devOnly);
    if (!isDroppedResume(r)) return r;
  }
  return null;
}

async function resumeOne(ctx: Ctx, researchThenDev: Runner, devOnly: Runner): Promise<WorkerIterationResult | null> {
  const next = pendingResumes(ctx)[0];
  if (!next) return null;
  let status: string;
  try {
    status = await ctx.deps.jira.getStatus(next.ticket);
  } catch (err) {
    // Left pending (no record appended); keep step 2/3 from claiming or running it this iteration.
    ctx.exclude.add(next.ticket);
    ctx.log(`[worker] ${next.ticket}: status lookup failed, resume left pending: ${errorMessage(err)}`);
    return null;
  }
  const expected = ctx.research.claimStatus.to;
  if (next.role === "dev" && status === ctx.dev.statusNames.prOpen) {
    return resolveAtCodeReview(ctx, next.ticket, next.runDir, next.since, "");
  }
  if (status !== expected) {
    return dropResume(ctx, next.ticket, `resume of the ${next.role} phase dropped: status is now "${status}", not "${expected}"`);
  }
  ctx.log(`[worker] ${next.ticket}: resuming the ${next.role} phase (no claim)`);
  if (next.role === "dev") {
    const pr = await openPr(ctx, next.ticket);
    if (pr) return selfHeal(ctx, next.ticket, pr, next.runDir, next.since, true);
  }
  const label = next.role === "research" ? ctx.research.triggerLabel : ctx.dev.triggerLabel;
  const t = knownTicket(ctx, next.ticket, [label]);
  return next.role === "research" ? researchThenDev(ctx, t, nowIso(ctx)) : devOnly(ctx, t, nowIso(ctx));
}
