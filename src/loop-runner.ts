/**
 * Single-pass loop iteration for the research-loop.
 *
 * Implements, as one pass, the 8 steps described in the pipeline spec:
 *   1. poll Jira via JQL for the oldest matching ticket
 *      -> if none, report an empty-queue result (caller sleeps & repeats)
 *   2. claim it via an atomic status transition
 *      -> if the claim loses a race, skip this ticket, do not throw
 *   3. spawn "claude -p" headless with the skill (injected as `runSkill`,
 *      never a real process from this module)
 *   4. read the verdict.json it wrote (missing/malformed -> outcome
 *      "error", failure_category "agent_error", via verdict.ts)
 *   5. transition the ticket and swap its pipeline-stage label per the
 *      verdict
 *   6. append exactly one line to runs.jsonl (via runs-log.ts)
 *   7. enforce ceilings (via ceilings.ts); on breach, PAUSE -- never
 *      silently continue
 *   8. (caller's responsibility) sleep and repeat
 *
 * All I/O boundaries -- Jira and "spawn claude -p" -- are injected so this
 * module never touches a real process or a real Jira instance.
 */

import type { Config, RunLogLine, Verdict } from "./types.ts";
import { CURRENT_LOG_VERSION } from "./types.ts";
import type { JiraClient, JiraTicket } from "./jira-client.ts";
import { checkCeilings } from "./ceilings.ts";
import { parseVerdict } from "./verdict.ts";
import { appendRunLog, hasLandedRun } from "./runs-log.ts";
import { excludeKeysFromJql } from "./jql.ts";

/**
 * What running the skill against a ticket produced. Stands in for the
 * real "spawn claude -p, then read verdict.json off disk" sequence --
 * `verdictRaw` is exactly what would have been read from verdict.json:
 * the JSON text, or undefined if the file was missing.
 */
export interface RunSkillResult {
  skill: string;
  skillVersion: string;
  model: string;
  /** ISO-8601 UTC timestamp. */
  startedAt: string;
  /** ISO-8601 UTC timestamp. */
  endedAt: string;
  /** Raw verdict.json content, or undefined if the skill never wrote one. */
  verdictRaw: string | undefined;
  /** Wall-clock run duration in minutes, for ceiling checks. */
  durationMin: number;
  costUsd: number;
  /**
   * Measured token usage from claude -p's own usage report (extractUsage()
   * in main.ts) -- not the skill's self-report. verdict.tokens is never
   * populated by either skill (their own schemas document cost_usd/tokens
   * as left at 0, deriving the real value from claude -p's usage report),
   * so buildRunLogLine must read this field, not verdict.tokens, or every
   * logged run silently records {in:0,out:0}.
   */
  tokens: { in: number; out: number };
}

/** Injected in place of a real `claude -p` spawn. */
export type RunSkillFn = (ticket: JiraTicket) => Promise<RunSkillResult>;

/** How this iteration concluded. */
export type LoopIterationAction =
  | "empty-queue"
  | "claim-raced"
  | "claim-error"
  | "processed"
  | "paused-ceiling";

export interface LoopIterationResult {
  action: LoopIterationAction;
  ticket?: string;
  logLine?: RunLogLine;
  /** Present when action is "paused-ceiling". */
  pauseReason?: string;
  /**
   * A Jira write failure message, surfaced so a caller can alert a human,
   * but never thrown. Two distinct cases share this field:
   *   - action "processed": the post-verdict write (swapLabel/
   *     transitionStatus) threw. The run itself still completed and is
   *     still logged; this only means Jira's state may be out of sync
   *     with runs.jsonl (the ticket may still sit at its old label/status).
   *   - action "claim-error": claim() itself threw, before any run
   *     happened -- nothing was logged for this ticket at all; see
   *     "claim-error" above.
   * Either way, one Jira write failing must never kill the loop or discard
   * an otherwise-real, already-completed run.
   */
  jiraSyncError?: string;
  /**
   * Polled tickets skipped before claiming because runs.jsonl already has a
   * "landed" line for them (a failed pipeline:research -> pipeline:dev label
   * swap left them matching the poll). Absent when none were skipped.
   */
  skippedLanded?: string[];
}

export interface RunLoopIterationDeps {
  jiraClient: JiraClient;
  config: Config;
  /** Resolved JQL to poll with -- callers build this via jql.ts. */
  jql: string;
  /** Stand-in for spawning `claude -p` with the skill. */
  runSkill: RunSkillFn;
  /** Path to the runs.jsonl file to append to. */
  runsLogPath: string;
  /** Number of runs already recorded today, for the maxRunsPerDay ceiling. */
  runsToday: number;
  /**
   * Jira accountId of the human who owns this pipeline's tickets. Used to
   * assign-if-unassigned a ticket right after it's claimed.
   */
  assigneeAccountId: string;
}

/**
 * Run exactly one iteration of the loop: poll, claim, run the skill, read
 * its verdict, transition status + swap label, log the run, and check
 * ceilings.
 * Does not sleep and does not loop -- callers own the poll/sleep cadence.
 */
export async function runLoopIteration(
  deps: RunLoopIterationDeps,
): Promise<LoopIterationResult> {
  const { jiraClient, config, jql, runSkill, runsLogPath, runsToday, assigneeAccountId } = deps;

  const preCheck = checkCeilings(config, {
    runsToday,
    runCostUsd: null,
    runDurationMin: null,
  });
  if (preCheck.breached) {
    return { action: "paused-ceiling", pauseReason: preCheck.detail };
  }

  // Never re-refine a ticket that already landed: skip it before claiming
  // (no status change, no run, no cost) and re-poll with it excluded so it
  // cannot block the queue.
  const skippedLanded: string[] = [];
  let ticket = await jiraClient.pollOldestMatching(jql);
  while (ticket && (await hasLandedRun(runsLogPath, ticket.key))) {
    skippedLanded.push(ticket.key);
    ticket = await jiraClient.pollOldestMatching(excludeKeysFromJql(jql, skippedLanded));
  }
  const skipped = skippedLanded.length > 0 ? { skippedLanded } : {};
  if (!ticket) {
    return { action: "empty-queue", ...skipped };
  }

  // A claim() throw (as opposed to its clean `false` lost-race return) is a
  // real Jira-side error -- e.g. a transition's screen has a required field
  // claim() doesn't send (see docs/future-enhancements.md's claim()-doesn't-
  // send-required-screen-fields entry). Left uncaught, this would propagate
  // out of runLoopIteration and kill the entire unattended poll loop over
  // one bad ticket. Caught here and reported as a distinct "claim-error"
  // action instead -- this does not fix the underlying Jira metadata gap
  // (still deferred), it only stops that gap from taking down the process.
  let claimed: boolean;
  try {
    claimed = await jiraClient.claim(
      ticket.key,
      config.jira.claimStatus.from,
      config.jira.claimStatus.to,
    );
  } catch (err) {
    const claimError = err instanceof Error ? err.message : String(err);
    return {
      action: "claim-error",
      ticket: ticket.key,
      jiraSyncError: claimError,
      ...skipped,
    };
  }
  if (!claimed) {
    return { action: "claim-raced", ticket: ticket.key, ...skipped };
  }

  let assignSyncError: string | undefined;
  if (ticket.assignee === null) {
    try {
      await jiraClient.assignTicket(ticket.key, assigneeAccountId);
    } catch (err) {
      assignSyncError = err instanceof Error ? err.message : String(err);
    }
  }

  const result = await runSkill(ticket);
  const verdict: Verdict = parseVerdict(result.verdictRaw);

  // ticket-refine reports its own passing verdict as "ready" (a refined
  // ticket, not a PR) -- normalize to "landed" for the shared RunOutcome
  // schema before anything downstream (the label swap, runs.jsonl) sees it.
  const outcome = verdict.outcome === "ready" ? "landed" : verdict.outcome;

  // Record this run's real consequences BEFORE checking the post-run
  // ceiling. A completed run already produced a real verdict -- a
  // ceiling breach must pause the loop from starting the NEXT run, but
  // must never discard work that already happened (the label swap, audit
  // log). Checking the ceiling first would silently drop a genuine
  // "landed" verdict just because it happened to cost/take more than
  // expected, which defeats the purpose of the audit trail.
  //
  // The Jira write itself is wrapped in try/catch: a malformed request or
  // a transient API error here must never throw out of this function --
  // that would propagate out of the caller's poll loop and kill the
  // entire unattended process over what is otherwise a real, completed
  // run. The run still gets logged either way; only the label/status may
  // be out of sync with what runs.jsonl says happened.
  let jiraSyncError: string | undefined = assignSyncError;
  try {
    if (outcome === "landed") {
      // Only an auto-promoted verdict swaps the label (straight to
      // handoffLabel, skipping human approval). A non-auto-promoted
      // landed verdict leaves the ticket at triggerLabel -- the ticket
      // just sits there, refined, until a human manually swaps the label.
      const autoPromote = ticket.labels.includes(config.autoPromoteLabel);
      if (autoPromote) {
        await jiraClient.swapLabel(
          ticket.key,
          config.jira.triggerLabel,
          config.jira.handoffLabel,
        );
      }
    } else if (outcome === "bounced") {
      await jiraClient.transitionStatus(ticket.key, config.jira.statusNames.bounced);
    }
  } catch (err) {
    const jiraWriteError = err instanceof Error ? err.message : String(err);
    jiraSyncError = jiraSyncError
      ? `${jiraSyncError}; ${jiraWriteError}`
      : jiraWriteError;
  }

  const logLine: RunLogLine = {
    ticket: ticket.key,
    skill: result.skill,
    skill_version: result.skillVersion,
    model: result.model,
    started: result.startedAt,
    ended: result.endedAt,
    outcome,
    phase_reached: verdict.phase_reached,
    red_confirmed: verdict.red_confirmed ?? false,
    verify_loops: verdict.verify_loops ?? 0,
    retries: verdict.retries ?? 0,
    failure_category: verdict.failure_category,
    detail: verdict.detail,
    pr: verdict.pr ?? null,
    cost_usd: result.costUsd,
    tokens: result.tokens,
    log_version: CURRENT_LOG_VERSION,
    // verdict.size_trajectory was already sanitized by parseVerdict (via
    // parseSizeTrajectory) above -- a malformed value never reaches here.
    ...(verdict.size_trajectory !== undefined
      ? { size_trajectory: verdict.size_trajectory }
      : {}),
  };

  await appendRunLog(runsLogPath, logLine);

  const postCheck = checkCeilings(config, {
    runsToday: runsToday + 1,
    runCostUsd: result.costUsd,
    runDurationMin: result.durationMin,
  });
  if (postCheck.breached) {
    return {
      action: "paused-ceiling",
      pauseReason: postCheck.detail,
      ticket: ticket.key,
      logLine,
      jiraSyncError,
      ...skipped,
    };
  }

  return { action: "processed", ticket: ticket.key, logLine, jiraSyncError, ...skipped };
}
