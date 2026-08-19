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
 *   5. transition the ticket and move its epic per the verdict
 *   6. append exactly one line to runs.jsonl (via runs-log.ts)
 *   7. enforce ceilings (via ceilings.ts); on breach, PAUSE -- never
 *      silently continue
 *   8. (caller's responsibility) sleep and repeat
 *
 * All I/O boundaries -- Jira and "spawn claude -p" -- are injected so this
 * module never touches a real process or a real Jira instance.
 */

import type { Config, RunLogLine, Verdict } from "./types.ts";
import type { JiraClient, JiraTicket } from "./jira-client.ts";
import { checkCeilings } from "./ceilings.ts";
import { parseVerdict } from "./verdict.ts";
import { appendRunLog } from "./runs-log.ts";

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
}

/** Injected in place of a real `claude -p` spawn. */
export type RunSkillFn = (ticket: JiraTicket) => Promise<RunSkillResult>;

/** How this iteration concluded. */
export type LoopIterationAction =
  | "empty-queue"
  | "claim-raced"
  | "processed"
  | "paused-ceiling";

export interface LoopIterationResult {
  action: LoopIterationAction;
  ticket?: string;
  logLine?: RunLogLine;
  /** Present when action is "paused-ceiling". */
  pauseReason?: string;
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
}

/**
 * Run exactly one iteration of the loop: poll, claim, run the skill, read
 * its verdict, transition + move epic, log the run, and check ceilings.
 * Does not sleep and does not loop -- callers own the poll/sleep cadence.
 */
export async function runLoopIteration(
  deps: RunLoopIterationDeps,
): Promise<LoopIterationResult> {
  const { jiraClient, config, jql, runSkill, runsLogPath, runsToday } = deps;

  const preCheck = checkCeilings(config, {
    runsToday,
    runCostUsd: null,
    runDurationMin: null,
  });
  if (preCheck.breached) {
    return { action: "paused-ceiling", pauseReason: preCheck.detail };
  }

  const ticket = await jiraClient.pollOldestMatching(jql);
  if (!ticket) {
    return { action: "empty-queue" };
  }

  const claimed = await jiraClient.claim(
    ticket.key,
    config.jira.claimStatus.from,
    config.jira.claimStatus.to,
  );
  if (!claimed) {
    return { action: "claim-raced", ticket: ticket.key };
  }

  const result = await runSkill(ticket);
  const verdict: Verdict = parseVerdict(result.verdictRaw);

  // ticket-refine reports its own passing verdict as "ready" (a refined
  // ticket, not a PR) -- normalize to "landed" for the shared RunOutcome
  // schema before anything downstream (epic move, runs.jsonl) sees it.
  const outcome = verdict.outcome === "ready" ? "landed" : verdict.outcome;

  // Record this run's real consequences BEFORE checking the post-run
  // ceiling. A completed run already produced a real verdict -- a
  // ceiling breach must pause the loop from starting the NEXT run, but
  // must never discard work that already happened (epic move, audit
  // log). Checking the ceiling first would silently drop a genuine
  // "landed" verdict just because it happened to cost/take more than
  // expected, which defeats the purpose of the audit trail.
  if (outcome === "landed") {
    const autoPromote = ticket.labels.includes(config.autoPromoteLabel);
    const targetEpic = autoPromote ? config.jira.readyEpic : config.jira.reviewEpic;
    await jiraClient.moveToEpic(ticket.key, targetEpic);
  } else if (outcome === "bounced") {
    await jiraClient.transitionStatus(ticket.key, config.jira.statusNames.bounced);
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
    tokens: verdict.tokens ?? { in: 0, out: 0 },
  };

  await appendRunLog(runsLogPath, logLine);

  const postCheck = checkCeilings(config, {
    runsToday: runsToday + 1,
    runCostUsd: result.costUsd,
    runDurationMin: result.durationMin,
  });
  if (postCheck.breached) {
    return { action: "paused-ceiling", pauseReason: postCheck.detail, ticket: ticket.key, logLine };
  }

  return { action: "processed", ticket: ticket.key, logLine };
}
