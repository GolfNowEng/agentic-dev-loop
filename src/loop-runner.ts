// The dev-loop iteration itself: poll -> claim -> spawn skill -> read
// verdict -> transition + move epic -> log -> check ceilings.
//
// Every side-effecting dependency (Jira access, spawning "claude -p") is
// injected so this module and its tests never touch a real process or a
// real Jira instance.

import type { JiraClient } from "./jira-client.ts";
import type { Config, RunLogLine, Verdict } from "./types.ts";
import { buildDevJql, buildRefineJql } from "./jql.ts";
import { checkCeilings, hasReachedMaxRunsPerDay } from "./ceilings.ts";
import { appendRunLog } from "./runs-log.ts";

/**
 * Injected stand-in for spawning "claude -p" headless with the skill.
 * Given the ticket key being worked, returns the Verdict the skill wrote
 * to verdict.json (already parsed - callers that need raw-file semantics
 * should use verdict.ts themselves before handing a Verdict here) along
 * with the wall-clock start/end timestamps of the run and the *measured*
 * cost from claude -p's own usage report -- ceilings must never trust
 * verdict.cost_usd, the skill's own self-report, since a misbehaving or
 * runaway agent could under-report it and defeat the ceiling entirely.
 */
export type RunSkillFn = (ticketKey: string) => Promise<{
  verdict: Verdict;
  started: string;
  ended: string;
  costUsd: number;
}>;

/**
 * Outcome of a single loop iteration, returned so callers (a real
 * long-running process, or a test) can decide what to do next.
 */
export type LoopIterationResult =
  | { kind: "idle" }
  | { kind: "skipped-race"; ticket: string }
  | { kind: "ran"; ticket: string; logLine: RunLogLine; jiraSyncError?: string }
  | {
      kind: "paused";
      reason: string;
      ticket?: string;
      logLine?: RunLogLine;
      jiraSyncError?: string;
    };

/**
 * Which polling loop this invocation is for - determines which JQL
 * template and which epic-move mapping applies.
 */
export type LoopKind = "refine" | "dev";

export interface LoopIterationDeps {
  jiraClient: JiraClient;
  config: Config;
  runSkill: RunSkillFn;
  loopKind: LoopKind;
  /** Path to the runs.jsonl file this iteration should append to. */
  runsLogPath: string;
  /** Number of runs already recorded today, for ceiling checks. */
  runsToday: number;
}

/**
 * Run exactly one iteration of the dev-loop:
 *   1. poll Jira via JQL for the oldest matching ticket (idle if none)
 *   2. claim it via an atomic status transition (skip-and-continue, not
 *      throw, if another process raced it)
 *   3. spawn "claude -p" headless with the skill (via the injected
 *      runSkill callback)
 *   4. read the verdict it wrote (missing/malformed -> "error" /
 *      "agent_error", handled by verdict.ts before this is called or
 *      within runSkill itself)
 *   5. transition the ticket and move its epic per the verdict
 *   6. append exactly one line to runs.jsonl
 *   7. enforce ceilings (max runs/day, max cost/run, run timeout); on
 *      breach, PAUSE (return a "paused" result), never silently continue
 *
 * Sleeping/repeating is the caller's responsibility - this function does
 * exactly one pass and returns.
 */
export async function runLoopIteration(
  deps: LoopIterationDeps,
): Promise<LoopIterationResult> {
  const { jiraClient, config, runSkill, loopKind, runsLogPath, runsToday } =
    deps;

  // Ceiling check before even starting a new run.
  if (hasReachedMaxRunsPerDay(runsToday, config.ceilings)) {
    return {
      kind: "paused",
      reason: `runsToday (${runsToday}) reached the maxRunsPerDay ceiling (${config.ceilings.maxRunsPerDay})`,
    };
  }

  const jql = loopKind === "refine" ? buildRefineJql(config) : buildDevJql(config);

  const ticket = await jiraClient.pollOldestMatching(jql);
  if (!ticket) {
    return { kind: "idle" };
  }

  const claimed = await jiraClient.claimTicket(
    ticket.key,
    config.jira.claimStatus.from,
    config.jira.claimStatus.to,
  );
  if (!claimed) {
    return { kind: "skipped-race", ticket: ticket.key };
  }

  const { verdict, started, ended, costUsd } = await runSkill(ticket.key);

  const runDurationMin =
    (new Date(ended).getTime() - new Date(started).getTime()) / 60000;

  // Record this run's real consequences BEFORE checking the post-run
  // ceiling. A completed run already produced a real verdict -- a
  // ceiling breach must pause the loop from starting the NEXT run, but
  // must never discard work that already happened (epic move, audit
  // log). Checking the ceiling first would silently drop a genuine
  // "landed" verdict just because it happened to cost/take more than
  // expected, which defeats the purpose of the audit trail.
  //
  // The Jira write itself is wrapped in try/catch: a malformed request or
  // a transient API error here must never throw out of this function --
  // that would propagate out of the caller's poll loop and kill the
  // entire unattended process over what is otherwise a real, completed
  // run. The run still gets logged either way; only the epic/status may
  // be out of sync with what runs.jsonl says happened.
  let jiraSyncError: string | undefined;
  try {
    const epic = decideEpicMove(verdict, loopKind, config);
    if (epic) {
      await jiraClient.moveToEpic(ticket.key, epic);
    } else if (verdict.outcome === "bounced") {
      await jiraClient.transitionStatus(ticket.key, config.jira.statusNames.bounced);
    }
  } catch (err) {
    jiraSyncError = err instanceof Error ? err.message : String(err);
  }

  const logLine = buildRunLogLine(ticket.key, verdict, started, ended, costUsd);
  await appendRunLog(runsLogPath, logLine);

  const ceilingResult = checkCeilings({
    runsToday: runsToday + 1,
    runCostUsd: costUsd,
    runDurationMin,
    config: config.ceilings,
  });

  if (ceilingResult.shouldPause) {
    return {
      kind: "paused",
      reason: ceilingResult.reason ?? "ceiling breach",
      ticket: ticket.key,
      logLine,
      jiraSyncError,
    };
  }

  return { kind: "ran", ticket: ticket.key, logLine, jiraSyncError };
}

/**
 * Decide which epic (if any) a ticket should move to given its verdict,
 * the loop it came from, and the configured autoPromoteLabel. A bounced
 * verdict must map to no epic move (the ticket stays in place); a
 * landed/passing verdict maps to reviewEpic or readyEpic depending on
 * loopKind and whether autoPromoteLabel gates the move.
 */
export function decideEpicMove(
  verdict: Verdict,
  loopKind: LoopKind,
  config: Config,
): string | null {
  if (verdict.outcome !== "landed") {
    return null;
  }

  return loopKind === "dev" ? config.jira.reviewEpic : config.jira.readyEpic;
}

/**
 * Derive the RunLogLine to append for this run from its Verdict and the
 * ticket/timing/skill metadata gathered around it. `costUsd` is the
 * measured cost from claude -p's own usage report, not verdict.cost_usd
 * (the skill's self-report) -- see RunSkillFn's doc comment.
 */
export function buildRunLogLine(
  ticket: string,
  verdict: Verdict,
  started: string,
  ended: string,
  costUsd: number,
): RunLogLine {
  return {
    ticket,
    skill: "ticket-to-pr",
    skill_version: verdict.skill_version,
    model: verdict.model,
    started,
    ended,
    outcome: verdict.outcome,
    phase_reached: verdict.phase_reached,
    red_confirmed: verdict.red_confirmed,
    verify_loops: verdict.verify_loops,
    retries: verdict.retries,
    failure_category: verdict.failure_category,
    detail: verdict.detail,
    pr: verdict.pr,
    cost_usd: costUsd,
    tokens: verdict.tokens,
  };
}
