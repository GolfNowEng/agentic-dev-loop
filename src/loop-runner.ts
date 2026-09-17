// The dev-loop iteration itself: poll -> claim -> spawn skill -> read
// verdict -> transition -> log -> check ceilings.
//
// Every side-effecting dependency (Jira access, spawning "claude -p") is
// injected so this module and its tests never touch a real process or a
// real Jira instance.

import type { JiraClient } from "./jira-client.ts";
import type { GitHubClient } from "./github-client.ts";
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
 * template applies.
 */
export type LoopKind = "refine" | "dev";

export interface LoopIterationDeps {
  jiraClient: JiraClient;
  githubClient: GitHubClient;
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
 * Post detail to the mirror GitHub Issue for this ticket, if one exists.
 * Non-fatal: a lookup/post failure or a missing Issue never throws --
 * folded into jiraSyncError (lookup/post failure) or silently skipped
 * (no Issue found), since a ticket predating research-loop's Phase 1
 * mirror-Issue rollout is an expected case, not an error.
 */
async function postGitHubDetail(
  githubClient: GitHubClient,
  ticketKey: string,
  body: string,
): Promise<string | undefined> {
  try {
    const issue = await githubClient.findIssueByJiraKey(ticketKey);
    if (!issue) return undefined;
    await githubClient.addComment(issue.number, body);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
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
 *   5. transition the ticket per the verdict
 *   6. append exactly one line to runs.jsonl
 *   7. enforce ceilings (max runs/day, max cost/run, run timeout); on
 *      breach, PAUSE (return a "paused" result), never silently continue
 *
 * No atomic claim step: this MVP assumes exactly one dev-loop instance is
 * ever running against a given project at a time (confirmed with the
 * user), so there's no race to guard against. dev-loop's poll JQL itself
 * (labels = "pipeline:dev" + assignee match) is what scopes which tickets
 * are eligible, no epic involved -- see docs/config.md's "Future:
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
  const { jiraClient, githubClient, config, runSkill, loopKind, runsLogPath, runsToday, assigneeAccountId } =
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
  // must never discard work that already happened (status transition,
  // audit log). Checking the ceiling first would silently drop a genuine
  // "landed" verdict just because it happened to cost/take more than
  // expected, which defeats the purpose of the audit trail.
  //
  // The Jira write itself is wrapped in try/catch: a malformed request or
  // a transient API error here must never throw out of this function --
  // that would propagate out of the caller's poll loop and kill the
  // entire unattended process over what is otherwise a real, completed
  // run. The run still gets logged either way; only the status may be
  // out of sync with what runs.jsonl says happened.
  let jiraSyncError: string | undefined = assignSyncError;
  try {
    if (loopKind === "dev" && verdict.outcome === "landed") {
      // A landed PR gets its status transitioned to Code Review. Status
      // alone -- In Progress -> Code Review -- is the "needs code review"
      // signal; nothing here moves an epic or label. That transition has
      // a required Jira screen (PII/QA-notes fields), so the fields must
      // be sent alongside it, not left empty.
      const fields = buildCodeReviewFields(config, buildQaNotesAdf(verdict));
      await jiraClient.transitionStatus(ticket.key, config.jira.statusNames.prOpen, fields);

      const githubError = await postGitHubDetail(
        githubClient,
        ticket.key,
        `Landed — PR: ${verdict.pr ?? "(none)"}, verify loops: ${verdict.verify_loops}.`,
      );
      if (githubError) {
        jiraSyncError = jiraSyncError ? `${jiraSyncError}; ${githubError}` : githubError;
      }
    } else if (verdict.outcome === "bounced" && verdict.pr !== null) {
      // Intake found this ticket's work already landed (nothing to do,
      // not a blocker) -- normally because an earlier run's landed-PR
      // transition to Code Review already succeeded, in which case
      // re-transitioning here is skipped as a no-op (see the status check
      // below). But if that earlier transition silently failed (a
      // transient API error caught by this same try/catch, or a race --
      // see poll-loop.ts's TARS-1389 writeup) the ticket's real status
      // never left "In Progress", so it still matches pollJql.dev's
      // prOpen exclusion (which only excludes tickets ALREADY at Code
      // Review) and every future poll cycle re-runs and re-bounces this
      // same ticket forever. Confirmed live on TARS-1465: PR #431 landed
      // but the status transition never took, so it re-ran and re-bounced
      // 7+ times over 45 minutes with no self-correction, at which point
      // a human had to intervene by hand. Self-heal here: if the ticket's
      // current status isn't already prOpen, transition it now, using
      // the same fields a normal landed verdict would send.
      if (ticket.status !== config.jira.statusNames.prOpen) {
        const fields = buildCodeReviewFields(config, buildQaNotesAdf(verdict));
        await jiraClient.transitionStatus(ticket.key, config.jira.statusNames.prOpen, fields);
      }

      const githubError = await postGitHubDetail(
        githubClient,
        ticket.key,
        `Bounced (${verdict.failure_category}): ${verdict.detail}`,
      );
      if (githubError) {
        jiraSyncError = jiraSyncError ? `${jiraSyncError}; ${githubError}` : githubError;
      }
    } else if (verdict.outcome === "bounced" && verdict.pr === null) {
      // A genuine blocker (spec_ambiguous, too_large, env_setup, etc.)
      // always happens before Phase 5 (PR) and therefore never has
      // verdict.pr set -- that's the only case Blocked should signal.
      //
      // Post the verdict's own evidence as a comment BEFORE the status
      // transition -- a bounce used to leave the ticket in Blocked with no
      // trace of why anywhere in Jira (the evidence only ever existed in
      // this repo's local runs.jsonl); posting first means a human reading
      // the ticket sees the reason even if the transition itself then
      // fails. Its own try/catch, independent of the transition below: a
      // failed comment must never block the Blocked transition itself --
      // that would leave the ticket silently stuck In Progress over a
      // comment-post failure alone, a worse outcome than "Blocked with no
      // comment." Both failures still merge into jiraSyncError.
      try {
        await jiraClient.addComment(ticket.key, buildBounceCommentAdf(verdict));
      } catch (commentErr) {
        const commentErrorMessage =
          commentErr instanceof Error ? commentErr.message : String(commentErr);
        jiraSyncError = jiraSyncError
          ? `${jiraSyncError}; ${commentErrorMessage}`
          : commentErrorMessage;
      }

      const githubError = await postGitHubDetail(
        githubClient,
        ticket.key,
        `Bounced (${verdict.failure_category}): ${verdict.detail}`,
      );
      if (githubError) {
        jiraSyncError = jiraSyncError ? `${jiraSyncError}; ${githubError}` : githubError;
      }

      await jiraClient.transitionStatus(ticket.key, config.jira.statusNames.bounced);
    }
  } catch (err) {
    const jiraWriteError = err instanceof Error ? err.message : String(err);
    jiraSyncError = jiraSyncError
      ? `${jiraSyncError}; ${jiraWriteError}`
      : jiraWriteError;
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
 * Build the QA-notes Atlassian Document (ADF) for Jira's QA Notes field
 * (customfield_14226).
 *
 * When the skill reported `qa_notes` (sequential manual-testing steps --
 * see the Verdict type's own doc comment), render a bold "Manual testing
 * steps:" header followed by an ordered list, one listItem per entry --
 * the same ADF shape the retired interactive qa-notes/push-branch skills
 * built by hand. Any entry starting with "Expected:" gets that prefix
 * bold-marked, matching that same convention, so a human QA reviewer can
 * scan action steps vs. expected results at a glance. This is genuinely
 * useful, step-by-step content -- distinct from, and never derived from,
 * the PR body's own terse "## QA Notes" pass/fail summary.
 *
 * When `qa_notes` is absent or empty (older verdicts, or a bounce with no
 * notes to give), fall back to the previous PR-link stub.
 *
 * customfield_14226 is a rich-text field: Jira rejects a plain string for
 * it ("Operation value must be an Atlassian Document"), confirmed against
 * a real transition attempt -- so this always returns a full ADF doc, not
 * a string.
 */
export function buildQaNotesAdf(verdict: Verdict): Record<string, unknown> {
  if (verdict.qa_notes && verdict.qa_notes.length > 0) {
    return {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Manual testing steps:", marks: [{ type: "strong" }] }],
        },
        {
          type: "orderedList",
          attrs: { order: 1 },
          content: verdict.qa_notes.map((step) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: qaNoteStepContent(step) }],
          })),
        },
      ],
    };
  }

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
 * Split one qa_notes entry into ADF text nodes. An "Expected:" prefix gets
 * its own bold-marked node followed by a plain node for the rest of the
 * line; every other entry is a single plain node.
 */
function qaNoteStepContent(step: string): Array<Record<string, unknown>> {
  const EXPECTED_PREFIX = "Expected:";
  if (step.startsWith(EXPECTED_PREFIX)) {
    return [
      { type: "text", text: EXPECTED_PREFIX, marks: [{ type: "strong" }] },
      { type: "text", text: step.slice(EXPECTED_PREFIX.length) },
    ];
  }
  return [{ type: "text", text: step }];
}

/**
 * Build the Jira comment ADF posted on a genuine bounce (see
 * runLoopIteration's Blocked branch), so a human reading the ticket sees
 * why it's blocked without having to go find this repo's local
 * runs.jsonl -- the same evidence already lands in the run log, this is
 * just the copy that reaches Jira. Bold "failure_category" label followed
 * by the skill's own one-line detail, matching the plain-paragraph shape
 * of buildQaNotesAdf's PR-link-stub fallback (no rich structure needed for
 * a single line). Opens with the `{✅|❌} dev-loop - <short context>`
 * convention (matching research-loop's own comment-title convention, per
 * docs/future-enhancements.md's "Simplify Jira/GitHub comment templates"
 * entry) as its bold first line, using `failure_category` directly as the
 * short-context text since it's already a closed, human-readable-enough
 * enum value for this repo's own bounce comment (research-loop's own
 * version writes a fuller plain-language phrase; this repo's existing
 * convention has always used the bare category name and this change
 * doesn't alter that, only the leading icon+repo-name prefix).
 */
export function buildBounceCommentAdf(verdict: Verdict): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `❌ dev-loop - ${verdict.failure_category}: `, marks: [{ type: "strong" }] },
          { type: "text", text: verdict.detail },
        ],
      },
    ],
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
