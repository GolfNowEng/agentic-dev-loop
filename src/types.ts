// Shared types for the dev-loop pipeline (Terminal B / executor).
//
// These types describe the data shapes the loop runner passes between its
// pure functions (jql, verdict, ceilings, runs-log) and its injected
// dependencies (JiraClient, run-skill callback). No behavior lives here.

/**
 * Closed enum of failure categories a run can be tagged with. This must
 * match the pipeline spec's failure_category enum exactly - do not add or
 * remove values without updating the spec.
 */
export type FailureCategory =
  | "spec_ambiguous"
  | "spec_contradicted"
  | "blocked"
  | "too_large"
  | "tests_flaky"
  | "env_setup"
  | "verify_rejected"
  | "subagent_stall"
  | "merge_conflict"
  | "agent_error"
  | "killed_ceiling";

/**
 * The set of terminal outcomes a run can have.
 */
export type RunOutcome = "landed" | "bounced" | "error" | "killed";

/**
 * The TDD phase the run reached before it stopped (successfully or not).
 */
export type RunPhase = "intake" | "plan" | "red" | "green" | "verify" | "pr";

/**
 * One line of runs.jsonl - the append-only run log. Field-for-field match
 * to the schema in the pipeline spec.
 */
export interface RunLogLine {
  ticket: string;
  skill: string;
  /** Git SHA of the skill at run time. */
  skill_version: string;
  model: string;
  /** ISO-8601 UTC timestamp, e.g. "2026-08-16T14:02:11Z". */
  started: string;
  /** ISO-8601 UTC timestamp, e.g. "2026-08-16T14:19:40Z". */
  ended: string;
  outcome: RunOutcome;
  phase_reached: RunPhase;
  red_confirmed: boolean;
  verify_loops: number;
  retries: number;
  failure_category: FailureCategory | null;
  /** One line, human-written by the skill. */
  detail: string;
  pr: string | null;
  cost_usd: number;
  tokens: {
    in: number;
    out: number;
  };
}

/**
 * What a skill's verdict.json contains. This is the raw signal the skill
 * hands back to the loop runner; the loop runner derives a RunLogLine from
 * it -- it no longer derives any epic-or-label-move decision at all
 * (decideEpicMove was deleted; no loop moves anything epic-or-label-shaped
 * on a landed dev-loop verdict).
 */
export interface Verdict {
  outcome: RunOutcome;
  phase_reached: RunPhase;
  failure_category: FailureCategory | null;
  /** One line, human-written by the skill. */
  detail: string;
  red_confirmed: boolean;
  verify_loops: number;
  retries: number;
  skill_version: string;
  model: string;
  pr: string | null;
  cost_usd: number;
  tokens: {
    in: number;
    out: number;
  };
  /**
   * Optional hint from the skill about which loop produced this verdict
   * ("refine" vs "dev"). Currently unread by this repo's own code (the
   * loop runner derives loopKind from its own invocation context, not
   * from this field) -- kept only for verdict.json schema shape.
   */
  loop?: "refine" | "dev";
  /**
   * Optional sequential manual-testing steps for a human QA reviewer --
   * e.g. "Navigate to `/rotten-tomatoes/critics?query=...`", "Expected:
   * the Self-Service badge appears next to the critic's name". Rendered
   * into Jira's QA Notes field (see loop-runner.ts's buildQaNotesAdf) as a
   * bold "Manual testing steps:" header + ordered list, matching the
   * retired interactive qa-notes/push-branch skills' ADF shape. Distinct
   * from nothing else: the PR body's "## QA Notes" carries this same list
   * (push-branch format). Absent/empty on older verdicts or bounced runs;
   * loop-runner falls back to the PR-link stub in that case.
   */
  qa_notes?: string[];
}

/** Claim-status transition pair, e.g. { from: "Ready", to: "In Progress" }. */
export interface ClaimStatusConfig {
  from: string;
  to: string;
}

/** JQL templates for the two polling loops. */
export interface PollJqlConfig {
  refine: string;
  dev: string;
}

export interface JiraConfig {
  /**
   * The label this repo's own poll matches on -- "pipeline:dev". Mutually
   * exclusive with triggerLabel-as-research-loop-sees-it: a ticket carries
   * exactly one pipeline-stage label at a time.
   */
  triggerLabel: string;
  /**
   * The label a passing research-loop verdict swaps a ticket to, handing
   * it off to this repo -- "pipeline:dev". Carried here for config-shape
   * symmetry with research-loop's own Config (mirroring how this repo's
   * Config already carries pollJql.refine today even though this repo's
   * runtime never polls with it), even though only research-loop's
   * loop-runner.ts performs the swap in Phase 0.
   */
  handoffLabel: string;
  /**
   * A second, always-paired label naming which repo a ticket belongs to --
   * e.g. "repo:catalog-ui-management". Needed because more than one target
   * repo can share the same Jira project (catalog-ui-management and
   * catalog-ui-public both file into project MC): the stage label alone
   * (triggerLabel/handoffLabel) can't tell those two apart, so pollJql ANDs
   * this label in too. Unlike triggerLabel/handoffLabel, repoLabel never
   * changes across a ticket's lifecycle -- it identifies the repo, not the
   * pipeline stage.
   */
  repoLabel: string;
  claimStatus: ClaimStatusConfig;
  pollJql: PollJqlConfig;
  /**
   * Which existing Jira status names the loop runner's terminal outcomes
   * map onto -- this Jira instance has no literal "bounced" or "pr-open"
   * status, so these must be bound to whatever statuses actually exist in
   * the ticket's workflow (e.g. "Blocked" for bounced, "In Progress" for
   * pr-open).
   */
  statusNames: {
    bounced: string;
    prOpen: string;
  };
  /**
   * Jira custom field IDs written when transitioning a landed PR to Code
   * Review -- mirrors what the interactive `push-branch` skill sets by
   * hand today (its "Transition ticket to Code Review" step), so an
   * automated PR gets the same Code Review screen fields populated
   * instead of the transition silently failing to happen at all.
   */
  codeReviewFields: {
    /** "Covered Information Data Inventory" multicheckboxes field. */
    piiField: string;
    /** Option id for its "No Impact" value. */
    piiNoImpactOptionId: string;
    /** "QA Notes" textarea field. */
    qaNotesField: string;
  };
}

export interface CeilingsConfig {
  maxRunsPerDay: number;
  maxCostPerRunUsd: number;
  runTimeoutMin: number;
}

/**
 * The codebase both skills operate against -- separate from this pipeline
 * repo itself, which only orchestrates. Kept in config (not hardcoded) so
 * the same pipeline repos can be pointed at a different project later.
 */
export interface TargetRepoConfig {
  /** git remote URL, e.g. "git@github.com:org/repo.git". */
  url: string;
  /** Branch new work branches from and PRs target, e.g. "master". */
  defaultBranch: string;
  /**
   * Local filesystem path to an existing checkout of `url`, if one exists
   * on this machine (e.g. "/Users/me/Repos/webtarsthree"). When set,
   * worktrees are created directly off this checkout instead of a fresh
   * clone into `.pipeline/<slug>/repo` -- faster, and its "origin" remote
   * is already the real one, so `ticket-to-pr`'s push/PR need no extra
   * setup. Optional: omit on a machine with no local checkout yet, and the
   * clone-based flow is used instead.
   */
  path?: string;
}

export interface GitHubConfig {
  /**
   * dev-loop's first GitHub write surface (addComment/closeIssue on the
   * mirror Issue research-loop already created). One target repo per
   * project config, same granularity as targetRepo -- derived from the
   * same codebase this repo's ticket-to-pr operates on, not a separate
   * system. Mirrors research-loop's own Config.github.repo field exactly.
   */
  /** "owner/repo" shorthand, e.g. "fandango/webtarsthree" -- passed
   * directly to `gh`'s own --repo flag, which accepts this exact shape. */
  repo: string;
}

/**
 * Shape of pipeline.loop.config.json -- loop-mechanics settings (how the
 * `main.ts` process behaves), kept separate from pipeline.<project>.config.json
 * (which project/Jira/repo it points at) since the two vary independently:
 * one loop-config file per repo checkout, not one per project.
 */
export interface LoopConfig {
  /** Seconds to sleep between polls when the queue is empty. */
  pollIntervalSec: number;
  /**
   * Seconds to wait after a run completes before polling again -- gives
   * Jira's search index time to reflect a just-written status transition
   * before the next poll can re-match the same ticket (confirmed cause of
   * a duplicate run landing ~2s after TARS-1389/1390/1393 each landed).
   */
  postRunDelaySec: number;
}

/**
 * Shape of pipeline.config.json.
 */
export interface Config {
  jira: JiraConfig;
  ceilings: CeilingsConfig;
  autoPromoteLabel: string;
  targetRepo: TargetRepoConfig;
  github: GitHubConfig;
}
