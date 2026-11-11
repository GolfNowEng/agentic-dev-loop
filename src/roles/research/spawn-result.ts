/**
 * Maps a spawnClaudeRun result that ended early (timeout kill or spawn
 * error) to the research role's RunSkillResult. Pure, so main.ts's wiring
 * of cost into runs.jsonl and the post-run ceiling is tested.
 */

import type { SpawnClaudeResult } from "../../core/spawn-claude.ts";
import { killedTimeoutVerdict } from "../../core/spawn-claude.ts";
import type { RunSkillResult } from "./phase.ts";

/**
 * null when the run completed normally (the caller then reads verdict.json).
 * Otherwise:
 *   - killedTimeout: a serialized outcome "killed" / "killed_ceiling" verdict.
 *   - spawnError: `verdictRaw: undefined`, which is v1's handling (the runner
 *     parses that as agent_error).
 * Either way the run's **measured** cost/tokens are carried through. See
 * roles/dev/spawn-result.ts for why that matters.
 */
export function researchEarlySkillResult(
  run: SpawnClaudeResult,
  base: { skill: string; skillVersion: string; model: string },
  timeoutMin: number,
): RunSkillResult | null {
  if (!run.killedTimeout && run.spawnError === undefined) return null;
  return {
    ...base,
    startedAt: run.started,
    endedAt: run.ended,
    durationMin: (new Date(run.ended).getTime() - new Date(run.started).getTime()) / 60000,
    verdictRaw: run.killedTimeout ? JSON.stringify(killedTimeoutVerdict(timeoutMin)) : undefined,
    costUsd: run.usage.costUsd,
    tokens: run.usage.tokens,
  };
}
