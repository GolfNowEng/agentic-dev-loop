/**
 * Shared types for the research-loop (Terminal A) pipeline.
 *
 * These types are the contract between:
 *   - pipeline.config.json (Config)
 *   - the skill's verdict.json output (Verdict)
 *   - the append-only runs.jsonl audit log (RunLogLine)
 */

/**
 * Closed enum of failure categories. This set is exact and exhaustive per
 * the pipeline spec -- do not add values here without updating the spec.
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

/** Outcome of a single run, as recorded in runs.jsonl. */
export type RunOutcome = "landed" | "bounced" | "error" | "killed";

/** Furthest phase the run reached before it ended. */
export type PhaseReached = "intake" | "plan" | "red" | "green" | "verify" | "pr";

/**
 * One line of runs.jsonl. Field-for-field match with the schema in the
 * pipeline spec. This is the *only* shape the runs-log appender is allowed
 * to write.
 */
export interface RunLogLine {
  ticket: string;
  skill: string;
  /** Git SHA of the skill at run time. */
  skill_version: string;
  model: string;
  /** ISO-8601 UTC timestamp. */
  started: string;
  /** ISO-8601 UTC timestamp. */
  ended: string;
  outcome: RunOutcome;
  phase_reached: PhaseReached;
  red_confirmed: boolean;
  verify_loops: number;
  retries: number;
  failure_category: FailureCategory | null;
  /** One line, human-written by the skill. */
  detail: string;
  pr: string | null;
  cost_usd: number;
  tokens: { in: number; out: number };
}

/**
 * What a skill writes to verdict.json. This is the skill's self-report of
 * what happened during its run -- the loop trusts it, combines it with
 * run-level bookkeeping (ticket id, timestamps, skill_version, model) it
 * did not need to report itself, and derives a RunLogLine plus an
 * epic-move decision from it.
 *
 * Every field the loop needs to act on a verdict (transition status, move
 * epic, log the run) must be derivable from this interface alone.
 */
export interface Verdict {
  outcome: RunOutcome;
  phase_reached: PhaseReached;
  failure_category: FailureCategory | null;
  /** One line, human-written by the skill. */
  detail: string;
  red_confirmed?: boolean;
  verify_loops?: number;
  retries?: number;
  pr?: string | null;
  cost_usd?: number;
  tokens?: { in: number; out: number };
}

/** Shape of pipeline.config.json. */
export interface Config {
  jira: {
    /** Epics whose tickets are candidates for the refine (skeptic) loop. */
    intakeEpics: string[];
    /** Epic a ticket moves to after a passing refine verdict (human review gate). */
    reviewEpic: string;
    /** Epic a ticket moves to when ready for dev-loop to pick up. */
    readyEpic: string;
    claimStatus: {
      from: string;
      to: string;
    };
    pollJql: {
      /** JQL template for the research-loop (refine/skeptic) poll. */
      refine: string;
      /** JQL template for the dev-loop poll. */
      dev: string;
    };
  };
  ceilings: {
    maxRunsPerDay: number;
    maxCostPerRunUsd: number;
    runTimeoutMin: number;
  };
  /**
   * Label that, when present on a ticket, allows a passing refine verdict
   * to skip the human review epic and go straight to the ready epic.
   */
  autoPromoteLabel: string;
}
