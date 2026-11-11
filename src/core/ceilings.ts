// Ceiling enforcement: max runs/day, max cost/run, run timeout.
//
// On breach the loop must PAUSE, never silently continue. This module is
// pure and role-agnostic: it takes counts/costs/durations plus explicit
// limits and returns a signal. It does not know how to stop the loop (that
// is the role's job), and it attaches no failure category -- the dev role
// sets "killed_ceiling" itself on a breach.

/** Which ceiling was breached. */
export type CeilingBreachReason = "maxRunsPerDay" | "maxCostPerRunUsd" | "runTimeoutMin";

/**
 * Result of a ceiling check. On `breached: true` the caller must stop
 * iterating and require a manual restart -- never treat it as a per-ticket
 * skip. `reason` names the first ceiling breached (runs/day, then cost,
 * then timeout); `detail` explains every ceiling breached, joined by "; ".
 */
export type CeilingCheckResult =
  | { breached: false }
  | { breached: true; reason: CeilingBreachReason; detail: string };

export interface CeilingLimits {
  maxRunsPerDay: number;
  maxCostPerRunUsd: number;
  runTimeoutMin: number;
}

export interface CeilingCheckInput {
  /** Runs counted against today's ceiling (including the current one, post-run). */
  runsToday: number;
  /** Cost in USD of the run being evaluated; null before a run (not checked). */
  runCostUsd: number | null;
  /** Wall-clock minutes of the run being evaluated; null before a run (not checked). */
  runDurationMin: number | null;
  limits: CeilingLimits;
}

/**
 * Evaluate all three ceilings. Pass nulls for cost/duration to check only
 * the runs/day ceiling before starting a run. Never throws on a breach --
 * a breach is an expected, handled condition.
 */
export function checkCeilings(input: CeilingCheckInput): CeilingCheckResult {
  const { runsToday, runCostUsd, runDurationMin, limits } = input;
  const breaches: Array<{ reason: CeilingBreachReason; detail: string }> = [];

  if (runsToday >= limits.maxRunsPerDay) {
    breaches.push({
      reason: "maxRunsPerDay",
      detail: `runsToday (${runsToday}) reached the maxRunsPerDay ceiling (${limits.maxRunsPerDay})`,
    });
  }
  if (runCostUsd !== null && runCostUsd > limits.maxCostPerRunUsd) {
    breaches.push({
      reason: "maxCostPerRunUsd",
      detail: `runCostUsd (${runCostUsd}) exceeded the maxCostPerRunUsd ceiling (${limits.maxCostPerRunUsd})`,
    });
  }
  if (runDurationMin !== null && runDurationMin > limits.runTimeoutMin) {
    breaches.push({
      reason: "runTimeoutMin",
      detail: `runDurationMin (${runDurationMin}) exceeded the runTimeoutMin ceiling (${limits.runTimeoutMin})`,
    });
  }

  if (breaches.length === 0) return { breached: false };
  return {
    breached: true,
    reason: breaches[0].reason,
    detail: breaches.map((b) => b.detail).join("; "),
  };
}

/**
 * Convenience assertion form (from research-loop): throws on a breach, for
 * callers that want pause-by-exception rather than inspecting a result.
 */
export function assertWithinCeilings(input: CeilingCheckInput): void {
  const result = checkCeilings(input);
  if (result.breached) {
    throw new Error(result.detail);
  }
}
