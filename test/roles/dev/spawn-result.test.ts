import { afterEach, describe, expect, it } from "vitest";
import { devEarlySkillResult } from "../../../src/roles/dev/spawn-result.ts";
import { runWorkerIteration } from "../../../src/worker/cycle.ts";
import { readIterations } from "../../../src/core/iteration-log.ts";
import { parseVerdict } from "../../../src/core/verdict.ts";
import type { SpawnClaudeResult } from "../../../src/core/spawn-claude.ts";
import { devTicket, harness, type Harness } from "../../worker/helpers.ts";

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

describe("devEarlySkillResult", () => {
  it("returns null for a clean run (the caller reads verdict.json)", () => {
    expect(devEarlySkillResult({ ...spawnErrorRun(), spawnError: undefined }, base, 75)).toBeNull();
  });

  it("spawnError with parsed usage: v1's agent_error verdict, but the real cost and tokens", () => {
    const result = devEarlySkillResult(spawnErrorRun(), base, 75)!;
    const v = parseVerdict(result.verdictRaw, "executor");
    expect(v.outcome).toBe("error");
    expect(v.failure_category).toBe("agent_error");
    expect(result.costUsd).toBe(12.3);
    expect(result.tokens).toEqual({ in: 4000, out: 300 });
  });

  it("killedTimeout: outcome killed / killed_ceiling with the real cost", () => {
    const result = devEarlySkillResult({ ...spawnErrorRun(), spawnError: undefined, killedTimeout: true }, base, 75)!;
    const v = parseVerdict(result.verdictRaw, "executor");
    expect(v.outcome).toBe("killed");
    expect(v.failure_category).toBe("killed_ceiling");
    expect(result.costUsd).toBe(12.3);
  });

  it("end to end through the cycle: the record has cost_usd 12.3 and the post-run ceiling (maxCostPerRunUsd 10) pauses", async () => {
    h = await harness({
      config: (c) => {
        c.roles.dev.ceilings = { maxCostPerRunUsd: 10, runTimeoutMin: 75 };
      },
      deps: { runSkill: async () => devEarlySkillResult(spawnErrorRun(), base, 75)! },
    });
    h.jira.dev = [devTicket("PROJ-1")];

    const result = await runWorkerIteration(h.deps);

    const [r] = await readIterations(h.logPath);
    expect(r.phases[0]).toMatchObject({ cost_usd: 12.3, tokens: { in: 4000, out: 300 }, outcome: "error", failure_category: "agent_error" });
    expect(result.kind).toBe("paused");
    if (result.kind === "paused") expect(result.reason).toMatch(/maxCostPerRunUsd/);
  });
});
