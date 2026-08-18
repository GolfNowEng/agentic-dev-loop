/**
 * Ceiling enforcement: maxRunsPerDay, maxCostPerRunUsd, runTimeoutMin.
 *
 * A breach must PAUSE the loop -- never be silently swallowed. Callers
 * (loop-runner.ts) are expected to stop iterating when checkCeilings
 * reports a breach, rather than continuing to the next poll.
 */

import type { Config } from "./types.js";

/** Which ceiling was breached, if any. */
export type CeilingBreachReason = "maxRunsPerDay" | "maxCostPerRunUsd" | "runTimeoutMin";

export interface CeilingBreach {
  breached: true;
  reason: CeilingBreachReason;
  /** Human-readable explanation, safe to log/print when pausing. */
  detail: string;
}

export interface CeilingOk {
  breached: false;
}

export type CeilingCheckResult = CeilingBreach | CeilingOk;

/** Minimal facts about the current day/run needed to evaluate ceilings. */
export interface CeilingInputs {
  /** Number of runs already recorded today (before this run). */
  runsToday: number;
  /** Cost in USD of the run just completed (or in progress), if known. */
  runCostUsd: number | null;
  /** Wall-clock duration of the run just completed (or in progress), in minutes. */
  runDurationMin: number | null;
}

/**
 * Evaluate the day's/run's stats against the config's ceilings and report
 * whether the loop should pause. Does not throw on a breach -- returns a
 * typed result so the caller can decide how to surface the pause.
 */
export function checkCeilings(config: Config, inputs: CeilingInputs): CeilingCheckResult {
  const { ceilings } = config;

  if (inputs.runsToday >= ceilings.maxRunsPerDay) {
    return {
      breached: true,
      reason: "maxRunsPerDay",
      detail: `runsToday (${inputs.runsToday}) reached the maxRunsPerDay ceiling (${ceilings.maxRunsPerDay})`,
    };
  }
  if (inputs.runCostUsd !== null && inputs.runCostUsd > ceilings.maxCostPerRunUsd) {
    return {
      breached: true,
      reason: "maxCostPerRunUsd",
      detail: `runCostUsd (${inputs.runCostUsd}) exceeded the maxCostPerRunUsd ceiling (${ceilings.maxCostPerRunUsd})`,
    };
  }
  if (inputs.runDurationMin !== null && inputs.runDurationMin > ceilings.runTimeoutMin) {
    return {
      breached: true,
      reason: "runTimeoutMin",
      detail: `runDurationMin (${inputs.runDurationMin}) exceeded the runTimeoutMin ceiling (${ceilings.runTimeoutMin})`,
    };
  }

  return { breached: false };
}

/**
 * Convenience assertion form: throws on a breach. Useful where the caller
 * wants pause-by-exception semantics rather than inspecting a result.
 */
export function assertWithinCeilings(config: Config, inputs: CeilingInputs): void {
  const result = checkCeilings(config, inputs);
  if (result.breached) {
    throw new Error(result.detail);
  }
}
