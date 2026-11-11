// Ceiling enforcement: max runs/day, max cost/run, run timeout.
//
// On breach the loop must PAUSE, never silently continue. This module is
// pure - it takes counts/costs/durations plus the configured limits and
// returns a signal; it does not know how to actually stop the loop (that's
// loop-runner's job).

import type { CeilingsConfig, FailureCategory } from "./types.ts";

/**
 * Result of a ceiling check. When shouldPause is true, the caller (the
 * loop runner) must stop iterating and require a manual restart - it must
 * never treat this as a per-ticket skip.
 */
export interface CeilingCheckResult {
  shouldPause: boolean;
  /** Human-readable reason for the pause, or null if no breach. */
  reason: string | null;
  /** Failure category to attach to the run that triggered the breach, if any. */
  failureCategory: FailureCategory | null;
}

/**
 * Everything needed to evaluate whether any ceiling has been breached for
 * the run that just finished (or is finishing).
 */
export interface CeilingCheckInput {
  /** How many runs have started today (including the current one). */
  runsToday: number;
  /** Cost in USD of the run being evaluated. */
  runCostUsd: number;
  /** Wall-clock duration in minutes of the run being evaluated. */
  runDurationMin: number;
  config: CeilingsConfig;
}

/**
 * Evaluate all three ceilings (runs/day, cost/run, run timeout) against a
 * single run's stats. Returns a "should pause" signal rather than
 * throwing - ceiling breaches are an expected, handled condition, not an
 * exceptional one.
 */
export function checkCeilings(input: CeilingCheckInput): CeilingCheckResult {
  const { runsToday, runCostUsd, runDurationMin, config } = input;
  const reasons: string[] = [];

  if (hasReachedMaxRunsPerDay(runsToday, config)) {
    reasons.push(
      `runsToday (${runsToday}) reached the maxRunsPerDay ceiling (${config.maxRunsPerDay})`,
    );
  }
  if (runCostUsd > config.maxCostPerRunUsd) {
    reasons.push(
      `runCostUsd (${runCostUsd}) exceeded the maxCostPerRunUsd ceiling (${config.maxCostPerRunUsd})`,
    );
  }
  if (runDurationMin > config.runTimeoutMin) {
    reasons.push(
      `runDurationMin (${runDurationMin}) exceeded the runTimeoutMin ceiling (${config.runTimeoutMin})`,
    );
  }

  if (reasons.length === 0) {
    return { shouldPause: false, reason: null, failureCategory: null };
  }

  return {
    shouldPause: true,
    reason: reasons.join("; "),
    failureCategory: "killed_ceiling",
  };
}

/**
 * Convenience check for just the runs/day ceiling, used by the loop before
 * even starting a new run (so it can pause before spawning the skill).
 */
export function hasReachedMaxRunsPerDay(
  runsToday: number,
  config: CeilingsConfig,
): boolean {
  return runsToday >= config.maxRunsPerDay;
}
