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
  /**
   * Measured token usage from claude -p's own usage report (extractUsage()
   * in main.ts) -- not the skill's self-report. verdict.tokens is never
   * populated by ticket-to-pr (its own schema documents cost_usd/tokens as
   * left at 0, deriving the real value from claude -p's usage report), so
   * buildRunLogLine must read this field, not verdict.tokens, or every
   * logged run silently records {in:0,out:0}.
   */
  tokens: { in: number; out: number };
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
  /**
   * Jira accountId of the human who owns this pipeline's tickets. Used
   * both to fill dev-loop's `{assignee}` JQL placeholder and to
   * assign-if-unassigned a ticket right after it's picked up.
   */
  assigneeAccountId: string;
}

/**
 * Run exactly one iteration of the dev-loop:
 *   1. poll Jira via JQL for the oldest matching ticket (idle if none)
 *   2. assign it to the configured human if it's currently unassigned
 *      (non-fatal -- a failure here surfaces as jiraSyncError, never
 *      throws or blocks the run)
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
 * No atomic claim step: this MVP assumes exactly one dev-loop instance is
 * ever running against a given project at a time (confirmed with the
 * user), so there's no race to guard against. dev-loop's poll JQL itself
 * (status "In Progress" + assignee match, inside the ready epic) is what
 * scopes which tickets are eligible -- see docs/config.md's "Future:
 * multiple concurrent loop instances" note for what real coordination
 * (e.g. a per-instance label) would need to look like if this is ever
 * relaxed.
 *
 * Sleeping/repeating is the caller's responsibility - this function does
 * exactly one pass and returns.
 */
export async function runLoopIteration(
  deps: LoopIterationDeps,
): Promise<LoopIterationResult> {
  const { jiraClient, config, runSkill, loopKind, runsLogPath, runsToday, assigneeAccountId } =
    deps;

  // Ceiling check before even starting a new run.
  if (hasReachedMaxRunsPerDay(runsToday, config.ceilings)) {
    return {
      kind: "paused",
      reason: `runsToday (${runsToday}) reached the maxRunsPerDay ceiling (${config.ceilings.maxRunsPerDay})`,
    };
  }

  const jql =
    loopKind === "refine" ? buildRefineJql(config) : buildDevJql(config, assigneeAccountId);

  const ticket = await jiraClient.pollOldestMatching(jql);
  if (!ticket) {
    return { kind: "idle" };
  }

  let assignSyncError: string | undefined;
  if (ticket.assignee === null) {
    try {
      await jiraClient.assignTicket(ticket.key, assigneeAccountId);
    } catch (err) {
      assignSyncError = err instanceof Error ? err.message : String(err);
    }
  }

  const { verdict, started, ended, costUsd, tokens } = await runSkill(ticket.key);

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
  let jiraSyncError: string | undefined = assignSyncError;
  try {
    const epic = decideEpicMove(verdict, loopKind, config);
    if (epic) {
      await jiraClient.moveToEpic(ticket.key, epic);
    }
    if (loopKind === "dev" && verdict.outcome === "landed") {
      // A landed PR gets its status transitioned to Code Review -- never
      // its epic. The epic (Pipeline: dev-loop) already means "dev-loop
      // is authorized to work this ticket"; moving it anywhere else would
      // make epic placement ambiguous depending on which ticket you're
      // looking at. Status alone -- In Progress -> Code Review -- is the
      // "needs code review" signal. That transition has a required Jira
      // screen (PII/QA-notes fields), so the fields must be sent alongside
      // it, not left empty.
      const fields = buildCodeReviewFields(config, buildQaNotesAdf(verdict));
      await jiraClient.transitionStatus(ticket.key, config.jira.statusNames.prOpen, fields);
    } else if (verdict.outcome === "bounced") {
      await jiraClient.transitionStatus(ticket.key, config.jira.statusNames.bounced);
    }
  } catch (err) {
    const epicMoveError = err instanceof Error ? err.message : String(err);
    jiraSyncError = jiraSyncError
      ? `${jiraSyncError}; ${epicMoveError}`
      : epicMoveError;
  }

  const logLine = buildRunLogLine(ticket.key, verdict, started, ended, costUsd, tokens);
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
 * Decide which epic (if any) a ticket should move to given its verdict
 * and the loop it came from. A bounced verdict never moves the epic (the
 * ticket stays in place). A landed dev-loop verdict never moves the epic
 * either -- a landed PR only transitions status (see runLoopIteration's
 * Code Review branch); the ticket stays in whatever epic it already sits
 * in (Pipeline: dev-loop). Only research-loop's own landed/ready verdicts
 * move an epic -- to readyEpic, when auto-promoted (see the "refine"
 * branch below); a non-auto-promoted verdict leaves the ticket in place
 * too, since research-loop's own intake and spec-review territory is now
 * a single combined epic (Pipeline: review-loop), not two.
 */
export function decideEpicMove(
  verdict: Verdict,
  loopKind: LoopKind,
  config: Config,
): string | null {
  if (verdict.outcome !== "landed" || loopKind === "dev") {
    return null;
  }

  return config.jira.readyEpic;
}

/**
 * Build the QA-notes Atlassian Document (ADF) from the verdict's own
 * fields -- mirrors what push-branch writes into Jira's "QA Notes" field
 * and the PR body's "## QA Notes" section, but sourced purely from
 * verdict.json rather than a separate skill contract. No skill
 * involvement, no new verdict field.
 *
 * customfield_14226 is a rich-text field: Jira rejects a plain string for
 * it ("Operation value must be an Atlassian Document"), confirmed against
 * a real transition attempt -- so this returns a full ADF doc, one
 * paragraph per line, not a string.
 */
export function buildQaNotesAdf(verdict: Verdict): Record<string, unknown> {
  const lines = [`PR: ${verdict.pr ?? "(none)"}`, `Verify loops: ${verdict.verify_loops}`];
  return {
    type: "doc",
    version: 1,
    content: lines.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

/**
 * Build the `fields` payload for the Code Review transition, mirroring
 * the interactive push-branch skill's own Jira write: it unconditionally
 * declares "No Impact" on the PII/security inventory field (no real PII
 * assessment happens here or in push-branch today -- a known gap, not
 * solved by this pipeline), plus the generated QA notes.
 */
export function buildCodeReviewFields(
  config: Config,
  qaNotesAdf: Record<string, unknown>,
): Record<string, unknown> {
  const { piiField, piiNoImpactOptionId, qaNotesField } = config.jira.codeReviewFields;
  return {
    [piiField]: [{ id: piiNoImpactOptionId }],
    [qaNotesField]: qaNotesAdf,
  };
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
  tokens: { in: number; out: number },
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
    tokens,
  };
}
