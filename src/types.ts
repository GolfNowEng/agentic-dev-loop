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
 * hands back to the loop runner; the loop runner derives a RunLogLine and
 * an epic-move decision from it.
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
   * ("refine" vs "dev"), used together with autoPromoteLabel to decide
   * which epic a "landed" ticket should move to. The loop runner may also
   * derive this from context rather than trusting the verdict.
   */
  loop?: "refine" | "dev";
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
  intakeEpics: string[];
  reviewEpic: string;
  readyEpic: string;
  claimStatus: ClaimStatusConfig;
  pollJql: PollJqlConfig;
  /**
   * How a ticket is linked to its epic in this Jira instance: either the
   * literal string "parent" (team-managed projects) or a custom field id
   * such as "customfield_10014" (company-managed projects). Placeholder
   * "___" until Appendix A of the pipeline spec is filled in.
   */
  epicLinkField: string;
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

/**
 * Shape of pipeline.loop.config.json -- loop-mechanics settings (how the
 * `main.ts` process behaves), kept separate from pipeline.<project>.config.json
 * (which project/Jira/repo it points at) since the two vary independently:
 * one loop-config file per repo checkout, not one per project.
 */
export interface LoopConfig {
  /** Seconds to sleep between polls when the queue is empty. */
  pollIntervalSec: number;
}

/**
 * Shape of pipeline.config.json.
 */
export interface Config {
  jira: JiraConfig;
  ceilings: CeilingsConfig;
  autoPromoteLabel: string;
  targetRepo: TargetRepoConfig;
}
