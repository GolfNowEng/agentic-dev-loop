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
}

export interface CeilingsConfig {
  maxRunsPerDay: number;
  maxCostPerRunUsd: number;
  runTimeoutMin: number;
}

/**
 * Shape of pipeline.config.json.
 */
export interface Config {
  jira: JiraConfig;
  ceilings: CeilingsConfig;
  autoPromoteLabel: string;
}
