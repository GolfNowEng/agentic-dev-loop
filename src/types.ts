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

/**
 * The full set of outcomes a Verdict's `outcome` field may hold. Equal to
 * RunOutcome plus "ready" -- ticket-refine's own passing-verdict word (a
 * ticket, not a PR, so "landed" would be misleading coming from this
 * skill). The loop runner normalizes "ready" to "landed" before writing a
 * RunLogLine, since runs.jsonl's schema is shared with dev-loop and only
 * ever uses RunOutcome.
 */
export type VerdictOutcome = RunOutcome | "ready";

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
 * did not need to report itself, and derives a RunLogLine from it -- no
 * epic-or-label-move decision is derived at all beyond the loop's own
 * fixed outcome->action mapping (see loop-runner.ts).
 *
 * Every field the loop needs to act on a verdict (transition status, swap
 * label, log the run) must be derivable from this interface alone.
 */
export interface Verdict {
  outcome: VerdictOutcome;
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
   * before the next poll can re-match the same ticket (same race dev-loop
   * confirmed live and fixed; see dev-loop's CHANGELOG.md, 2026-09-02).
   */
  postRunDelaySec: number;
}

/** Shape of pipeline.config.json. */
export interface Config {
  jira: {
    /**
     * The label this repo's own poll matches on -- "pipeline:research".
     * Mutually exclusive with handoffLabel: a ticket carries exactly one
     * pipeline-stage label at a time.
     */
    triggerLabel: string;
    /**
     * The label a passing, human-approved (or autoPromoteLabel-gated)
     * verdict swaps a ticket to, handing it off to dev-loop --
     * "pipeline:dev". Carried here for config-shape symmetry with
     * dev-loop's own Config, even though only this repo's loop-runner.ts
     * performs the swap in Phase 0.
     */
    handoffLabel: string;
    /**
     * A second, always-paired label naming which repo a ticket belongs to
     * -- e.g. "repo:catalog-ui-management". Needed because more than one
     * target repo can share the same Jira project (catalog-ui-management
     * and catalog-ui-public both file into project MC): the stage label
     * alone (triggerLabel/handoffLabel) can't tell those two apart, so
     * pollJql ANDs this label in too. Unlike triggerLabel/handoffLabel,
     * repoLabel never changes across a ticket's lifecycle -- it identifies
     * the repo, not the pipeline stage. Ported from dev-loop's identical
     * field (see dev-loop's CHANGELOG.md, 2026-09-16).
     */
    repoLabel: string;
    /**
     * Jira accountId to @-mention in every Jira-worthy comment this repo
     * writes (per the routing rule -- see SKILL.md's "Ticket content
     * protocol"). Sourced the same way JIRA_ASSIGNEE_ACCOUNT_ID/
     * assigneeAccountIdFromEnv already works in jira-client.ts, but this
     * is a config field, not an env var, since the person to mention is a
     * per-project decision (who owns this project's tickets), not a
     * per-machine/per-runner-identity setting.
     */
    mentionAccountId: string;
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
  };
  /**
   * Phase 1 of the Jira-label-trigger design (docs/future-enhancements.md):
   * this pipeline mirrors every claimed ticket into a GitHub Issue and
   * posts recon/attack/verify/working-note content there instead of Jira,
   * per the routing rule in SKILL.md. One target repo per project config,
   * same granularity as targetRepo -- derived from the same codebase this
   * skill grounds tickets against, not a separate system.
   */
  github: {
    /** "owner/repo" shorthand, e.g. "fandango/webtarsthree" -- passed
     * directly to `gh`'s own --repo flag, which accepts this exact shape. */
    repo: string;
  };
  ceilings: {
    maxRunsPerDay: number;
    maxCostPerRunUsd: number;
    runTimeoutMin: number;
  };
  /**
   * A ticket label that lets a passing verdict skip human approval and
   * swap the ticket straight from `triggerLabel` to `handoffLabel`.
   * Without it, a passing verdict leaves the ticket at `triggerLabel`,
   * refined and awaiting approval.
   */
  autoPromoteLabel: string;
  /**
   * The codebase this skill grounds tickets against -- separate from this
   * pipeline repo itself, which only orchestrates. Kept in config (not
   * hardcoded) so the same pipeline repos can be pointed at a different
   * project later.
   */
  targetRepo: {
    /** git remote URL, e.g. "git@github.com:org/repo.git". */
    url: string;
    /** Branch treated as the current baseline, e.g. "master". */
    defaultBranch: string;
    /**
     * Local filesystem path to an existing checkout of `url`, if one
     * exists on this machine (e.g. "/Users/me/Repos/webtarsthree"). When
     * set, worktrees are created directly off this checkout instead of a
     * fresh clone into `.pipeline/<slug>/repo` -- faster, and its "origin"
     * remote is already the real one, so push/PR just work with no extra
     * setup. Optional: omit on a machine with no local checkout yet, and
     * the clone-based flow is used instead.
     */
    path?: string;
  };
}
