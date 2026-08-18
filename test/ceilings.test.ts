import { describe, expect, it } from "vitest";
import { checkCeilings, hasReachedMaxRunsPerDay } from "../src/ceilings.ts";
import type { CeilingsConfig } from "../src/types.ts";

const config: CeilingsConfig = {
  maxRunsPerDay: 10,
  maxCostPerRunUsd: 5,
  runTimeoutMin: 30,
};

describe("checkCeilings", () => {
  it("does not pause when all stats are within limits", () => {
    const result = checkCeilings({
      runsToday: 3,
      runCostUsd: 1.5,
      runDurationMin: 10,
      config,
    });
    expect(result.shouldPause).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.failureCategory).toBeNull();
  });

  it("pauses when runsToday reaches maxRunsPerDay", () => {
    const result = checkCeilings({
      runsToday: 10,
      runCostUsd: 1,
      runDurationMin: 5,
      config,
    });
    expect(result.shouldPause).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(result.failureCategory).toBe("killed_ceiling");
  });

  it("pauses when runCostUsd exceeds maxCostPerRunUsd", () => {
    const result = checkCeilings({
      runsToday: 1,
      runCostUsd: 5.01,
      runDurationMin: 5,
      config,
    });
    expect(result.shouldPause).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(result.failureCategory).toBe("killed_ceiling");
  });

  it("pauses when runDurationMin exceeds runTimeoutMin", () => {
    const result = checkCeilings({
      runsToday: 1,
      runCostUsd: 1,
      runDurationMin: 31,
      config,
    });
    expect(result.shouldPause).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(result.failureCategory).toBe("killed_ceiling");
  });

  it("never throws on a breach - it returns a should-pause signal", () => {
    expect(() =>
      checkCeilings({
        runsToday: 999,
        runCostUsd: 999,
        runDurationMin: 999,
        config,
      }),
    ).not.toThrow();
  });
});

describe("hasReachedMaxRunsPerDay", () => {
  it("returns false below the ceiling", () => {
    expect(hasReachedMaxRunsPerDay(9, config)).toBe(false);
  });

  it("returns true at or above the ceiling", () => {
    expect(hasReachedMaxRunsPerDay(10, config)).toBe(true);
    expect(hasReachedMaxRunsPerDay(11, config)).toBe(true);
  });
});
