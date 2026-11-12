import { afterEach, describe, expect, it } from "vitest";
import { researchEarlySkillResult } from "../../../src/roles/research/spawn-result.ts";
import { runWorkerIteration } from "../../../src/worker/cycle.ts";
import { readIterations } from "../../../src/core/iteration-log.ts";
import type { SpawnClaudeResult } from "../../../src/core/spawn-claude.ts";
import { harness, ticket, type Harness } from "../../worker/helpers.ts";

const base = { skillVersion: "abc", model: "sonnet" };

function spawnErrorRun(): SpawnClaudeResult {
  return {
    stdout: '{"type":"result","subtype":"error_max_budget_usd","total_cost_usd":12.3}',
    usage: { costUsd: 12.3, tokens: { in: 4000, out: 300 } },
    started: "2026-11-10T10:00:00.000Z",
    ended: "2026-11-10T10:20:00.000Z",
    spawnError: "claude exited with code 1. Output: ...",
    killedTimeout: false,
  };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("researchEarlySkillResult", () => {
  it("returns null for a clean run (the caller reads verdict.json)", () => {
    expect(researchEarlySkillResult({ ...spawnErrorRun(), spawnError: undefined }, base, 120)).toBeNull();
  });

  it("spawnError with parsed usage: v1's missing-verdict result, but the real cost and tokens", () => {
    const result = researchEarlySkillResult(spawnErrorRun(), base, 120)!;
    expect(result.verdictRaw).toBeUndefined();
    expect(result.costUsd).toBe(12.3);
    expect(result.tokens).toEqual({ in: 4000, out: 300 });
    expect(result.started).toBe("2026-11-10T10:00:00.000Z");
    expect(result.skillVersion).toBe("abc");
  });

  it("killedTimeout: a killed / killed_ceiling verdict with the real cost", () => {
    const result = researchEarlySkillResult({ ...spawnErrorRun(), spawnError: undefined, killedTimeout: true }, base, 120)!;
    expect(JSON.parse(result.verdictRaw!).outcome).toBe("killed");
    expect(result.costUsd).toBe(12.3);
  });

  it("end to end through the cycle: the record has cost_usd 12.3, agent_error, and the post-run ceiling (maxCostPerRunUsd 10) pauses", async () => {
    h = await harness({
      config: (c) => {
        c.roles.research.ceilings = { maxCostPerRunUsd: 10, runTimeoutMin: 120 };
      },
      deps: { runSkill: async () => researchEarlySkillResult(spawnErrorRun(), base, 120)! },
    });
    h.jira.research = [ticket("PROJ-1")];

    const result = await runWorkerIteration(h.deps);

    const [r] = await readIterations(h.logPath);
    expect(r.phases[0]).toMatchObject({ cost_usd: 12.3, tokens: { in: 4000, out: 300 }, outcome: "error", failure_category: "agent_error" });
    expect(result.kind).toBe("paused");
    if (result.kind === "paused") expect(result.reason).toMatch(/maxCostPerRunUsd/);
  });
});
