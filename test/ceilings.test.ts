import { describe, it, expect } from "vitest";
import { checkCeilings, assertWithinCeilings } from "../src/ceilings.ts";
import type { Config } from "../src/types.ts";

function makeConfig(overrides: Partial<Config["ceilings"]> = {}): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      repoLabel: "repo:org-repo",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: { refine: 'labels = "{label}"', dev: 'labels = "{label}"' },
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
    },
    ceilings: {
      maxRunsPerDay: 10,
      maxCostPerRunUsd: 5,
      runTimeoutMin: 30,
      ...overrides,
    },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}

describe("checkCeilings", () => {
  it("reports no breach when under every ceiling", () => {
    const config = makeConfig();
    const result = checkCeilings(config, {
      runsToday: 3,
      runCostUsd: 1,
      runDurationMin: 5,
    });
    expect(result.breached).toBe(false);
  });

  it("reports a breach when runsToday meets/exceeds maxRunsPerDay", () => {
    const config = makeConfig({ maxRunsPerDay: 10 });
    const result = checkCeilings(config, {
      runsToday: 10,
      runCostUsd: 1,
      runDurationMin: 5,
    });
    expect(result.breached).toBe(true);
    if (result.breached) {
      expect(result.reason).toBe("maxRunsPerDay");
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it("reports a breach when runCostUsd exceeds maxCostPerRunUsd", () => {
    const config = makeConfig({ maxCostPerRunUsd: 5 });
    const result = checkCeilings(config, {
      runsToday: 1,
      runCostUsd: 5.01,
      runDurationMin: 5,
    });
    expect(result.breached).toBe(true);
    if (result.breached) {
      expect(result.reason).toBe("maxCostPerRunUsd");
    }
  });

  it("reports a breach when runDurationMin exceeds runTimeoutMin", () => {
    const config = makeConfig({ runTimeoutMin: 30 });
    const result = checkCeilings(config, {
      runsToday: 1,
      runCostUsd: 1,
      runDurationMin: 31,
    });
    expect(result.breached).toBe(true);
    if (result.breached) {
      expect(result.reason).toBe("runTimeoutMin");
    }
  });

  it("assertWithinCeilings throws on breach and does not throw when ok", () => {
    const config = makeConfig({ maxRunsPerDay: 1 });
    expect(() =>
      assertWithinCeilings(config, { runsToday: 1, runCostUsd: 0, runDurationMin: 0 }),
    ).toThrow();
    expect(() =>
      assertWithinCeilings(config, { runsToday: 0, runCostUsd: 0, runDurationMin: 0 }),
    ).not.toThrow();
  });
});
