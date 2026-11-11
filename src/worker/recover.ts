// Cycle step 0: resume a phase run lost when a previous process died
// mid-phase (the session lock's inFlight, then any orphanedInFlight).
//
// The lost run is always recorded as a failed attempt (an `error` phase,
// agent_error, "in-flight ... from a crashed session"):
//   - research: that error record is appended first (durable before a long
//     re-run), then runResearchPhase re-runs without a claim (the ticket is
//     already In Progress), followed by the normal ceiling check, handoff and
//     dev, in a second record.
//   - dev with an open PR: self-heal. transitionStatus(prOpen) with the
//     Code Review fields (PR-link QA stub), no rebuild; one record,
//     "skipped-pr-exists", carrying the lost run's error phase.
//   - dev without a PR: the error record, then runDevPhase again.
// If the lost run takes the ticket to maxAttemptsPerTicket, it is not
// re-run: step 2 blocks it on the next iteration.

import type { JiraTicket } from "../core/jira-client.ts";
import type { InFlight } from "../core/session.ts";
import type { PhaseEntry } from "../core/iteration-log.ts";
import { failedAttempts } from "../core/iteration-log.ts";
import { errorMessage } from "../core/run-skill.ts";
import { buildCodeReviewFields, buildPrLinkQaNotesAdf } from "../roles/dev/code-review.ts";
import { append, crashEntry, knownTicket, nowIso, type Ctx, type WorkerIterationResult } from "./context.ts";

type ResearchThenDev = (ctx: Ctx, t: JiraTicket, started: string, prior: PhaseEntry[]) => Promise<WorkerIterationResult>;
type DevOnly = (ctx: Ctx, t: JiraTicket, started: string, prior: PhaseEntry[]) => Promise<WorkerIterationResult>;

export async function recoverOne(ctx: Ctx, f: InFlight, researchThenDev: ResearchThenDev, devOnly: DevOnly): Promise<WorkerIterationResult> {
  const { deps } = ctx;
  const started = nowIso(ctx);
  const lost = crashEntry(ctx, f, `in-flight ${f.role} run (since ${f.since}) lost: its process died (crashed session); resumed`);
  ctx.log(`[worker] ${f.ticket}: recovering in-flight ${f.role} run from ${f.since}`);

  if (f.role === "dev") {
    let pr: string | null = null;
    try {
      pr = await deps.findOpenPrUrl(f.ticket);
    } catch (err) {
      ctx.log(`[worker] ${f.ticket}: open-PR lookup failed, re-running dev: ${errorMessage(err)}`);
    }
    if (pr) {
      const errors: string[] = [];
      try {
        await deps.jira.transitionStatus(f.ticket, ctx.dev.statusNames.prOpen, buildCodeReviewFields(ctx.dev, buildPrLinkQaNotesAdf(pr)));
      } catch (err) {
        errors.push(errorMessage(err));
      }
      const record = await append(ctx, f.ticket, started, "skipped-pr-exists", [lost], {
        detail: `PR already open (${pr}); moved to ${ctx.dev.statusNames.prOpen} without a rebuild`,
        ...(errors.length > 0 ? { jira_sync_error: errors.join("; ") } : {}),
      });
      return { kind: "did", record };
    }
  }

  const crash = await append(ctx, f.ticket, started, "error", [lost], { detail: "orphaned in-flight run from a crashed session" });
  if (failedAttempts(ctx.records, f.ticket, f.role) >= deps.config.ceilings.maxAttemptsPerTicket) {
    ctx.log(`[worker] ${f.ticket}: not resumed, maxAttemptsPerTicket reached`);
    return { kind: "did", record: crash };
  }
  const label = f.role === "research" ? ctx.research.triggerLabel : ctx.dev.triggerLabel;
  const t = knownTicket(ctx, f.ticket, [label]);
  return f.role === "research" ? researchThenDev(ctx, t, nowIso(ctx), []) : devOnly(ctx, t, nowIso(ctx), []);
}
