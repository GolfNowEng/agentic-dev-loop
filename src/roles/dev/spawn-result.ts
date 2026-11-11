/**
 * Maps a spawnClaudeRun result that ended early (timeout kill or spawn
 * error) to the dev role's RunSkillFn result. Pure, so main.ts's wiring of
 * cost into runs.jsonl and the post-run ceiling is tested.
 */

import type { SpawnClaudeResult } from "../../core/spawn-claude.ts";
import { killedTimeoutVerdict } from "../../core/spawn-claude.ts";
import { agentErrorVerdict } from "../../core/verdict.ts";
import type { RunSkillFn } from "./phase.ts";

type DevSkillResult = Awaited<ReturnType<RunSkillFn>>;

/**
 * null when the run completed normally (the caller then reads verdict.json).
 * Otherwise:
 *   - killedTimeout: outcome "killed" / "killed_ceiling".
 *   - spawnError: v1's agent_error verdict carrying the error message.
 * Either way the run's **measured** cost/tokens are carried through.
 * spawnClaudeRun returns zero usage when the child printed nothing, and the
 * parsed usage when it printed a result before exiting nonzero (e.g. the
 * --max-budget-usd cap). Logging 0 there would let a budget-capped run
 * bypass maxCostPerRunUsd and stats.
 */
export function devEarlySkillResult(run: SpawnClaudeResult, timeoutMin: number): DevSkillResult | null {
  if (!run.killedTimeout && run.spawnError === undefined) return null;
  return {
    verdict: run.killedTimeout ? killedTimeoutVerdict(timeoutMin) : agentErrorVerdict(run.spawnError!),
    started: run.started,
    ended: run.ended,
    costUsd: run.usage.costUsd,
    tokens: run.usage.tokens,
  };
}
