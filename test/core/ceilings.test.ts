import { describe, expect, it } from "vitest";
import { assertWithinCeilings, checkCeilings } from "../../src/core/ceilings.ts";
import type { CeilingLimits } from "../../src/core/ceilings.ts";

const limits: CeilingLimits = {
  maxRunsPerDay: 10,
  maxCostPerRunUsd: 5,
  runTimeoutMin: 30,
};

describe("checkCeilings", () => {
  it("reports no breach when all stats are within limits", () => {
    const result = checkCeilings({ runsToday: 3, runCostUsd: 1.5, runDurationMin: 10, limits });
    expect(result).toEqual({ breached: false });
  });

  it("reports a maxRunsPerDay breach when runsToday reaches the ceiling", () => {
    const result = checkCeilings({ runsToday: 10, runCostUsd: 1, runDurationMin: 5, limits });
    expect(result.breached).toBe(true);
    if (result.breached) {
      expect(result.reason).toBe("maxRunsPerDay");
      expect(result.detail).toContain("maxRunsPerDay");
    }
  });

  it("reports a maxCostPerRunUsd breach when runCostUsd exceeds the ceiling", () => {
    const result = checkCeilings({ runsToday: 1, runCostUsd: 5.01, runDurationMin: 5, limits });
    expect(result.breached).toBe(true);
    if (result.breached) expect(result.reason).toBe("maxCostPerRunUsd");
  });

  it("reports a runTimeoutMin breach when runDurationMin exceeds the ceiling", () => {
    const result = checkCeilings({ runsToday: 1, runCostUsd: 1, runDurationMin: 31, limits });
    expect(result.breached).toBe(true);
    if (result.breached) expect(result.reason).toBe("runTimeoutMin");
  });

  it("is a runs/day-only check when cost and duration are null (pre-run)", () => {
    expect(checkCeilings({ runsToday: 9, runCostUsd: null, runDurationMin: null, limits })).toEqual({
      breached: false,
    });
    expect(checkCeilings({ runsToday: 10, runCostUsd: null, runDurationMin: null, limits }).breached).toBe(true);
    expect(checkCeilings({ runsToday: 11, runCostUsd: null, runDurationMin: null, limits }).breached).toBe(true);
  });

  it("on several breaches, reason is the first one and detail lists them all", () => {
    const result = checkCeilings({ runsToday: 999, runCostUsd: 999, runDurationMin: 999, limits });
    expect(result.breached).toBe(true);
    if (result.breached) {
      expect(result.reason).toBe("maxRunsPerDay");
      expect(result.detail).toContain("maxRunsPerDay");
      expect(result.detail).toContain("maxCostPerRunUsd");
      expect(result.detail).toContain("runTimeoutMin");
    }
  });

  it("never throws on a breach - it returns a breached signal", () => {
    expect(() =>
      checkCeilings({ runsToday: 999, runCostUsd: 999, runDurationMin: 999, limits }),
    ).not.toThrow();
  });
});

describe("assertWithinCeilings", () => {
  it("throws on breach and does not throw when ok", () => {
    const tight = { ...limits, maxRunsPerDay: 1 };
    expect(() =>
      assertWithinCeilings({ runsToday: 1, runCostUsd: 0, runDurationMin: 0, limits: tight }),
    ).toThrow();
    expect(() =>
      assertWithinCeilings({ runsToday: 0, runCostUsd: 0, runDurationMin: 0, limits: tight }),
    ).not.toThrow();
  });
});
