import { describe, it, expect } from "vitest";
import { buildRefineJql, buildDevJql } from "../src/jql.ts";
import type { Config } from "../src/types.ts";

function makeConfig(): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" AND status = "Backlog" ORDER BY created ASC',
        dev: 'labels = "{label}" ORDER BY created ASC',
      },
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}

describe("buildRefineJql", () => {
  it("substitutes triggerLabel into the refine template", () => {
    const jql = buildRefineJql(makeConfig());
    expect(jql).toContain("pipeline:research");
    expect(jql).not.toContain("{label}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    const jql = buildRefineJql(makeConfig());
    expect(jql).toContain("ORDER BY created ASC");
  });
});

describe("buildDevJql", () => {
  it("substitutes handoffLabel into the dev template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("pipeline:dev");
    expect(jql).not.toContain("{label}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("ORDER BY created ASC");
  });
});
