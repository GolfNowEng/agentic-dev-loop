import { describe, it, expect } from "vitest";
import { buildRefineJql, buildDevJql, excludeKeysFromJql } from "../../src/core/jql.ts";
import type { Config } from "../../src/core/types.ts";

function makeConfig(): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      repoLabel: "repo:webtarsthree",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" AND labels = "{repoLabel}" AND status = "Backlog" ORDER BY created ASC',
        dev: 'labels = "{label}" AND labels = "{repoLabel}" ORDER BY created ASC',
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

  it("substitutes repoLabel into the refine template, disambiguating repos that share one Jira project", () => {
    const jql = buildRefineJql(makeConfig());
    expect(jql).toContain("repo:webtarsthree");
    expect(jql).not.toContain("{repoLabel}");
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

  it("substitutes repoLabel into the dev template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("repo:webtarsthree");
    expect(jql).not.toContain("{repoLabel}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("ORDER BY created ASC");
  });
});

describe("excludeKeysFromJql", () => {
  it("returns the jql unchanged when there are no keys to exclude", () => {
    expect(excludeKeysFromJql('labels = "x"', [])).toBe('labels = "x"');
  });

  it("appends a key-not-in clause", () => {
    expect(excludeKeysFromJql('labels = "x"', ["A-1", "A-2"])).toBe(
      'labels = "x" AND key not in ("A-1","A-2")',
    );
  });

  it("inserts the clause before ORDER BY, case-insensitively", () => {
    expect(excludeKeysFromJql('labels = "x" order by created ASC', ["A-1"])).toBe(
      'labels = "x" AND key not in ("A-1") order by created ASC',
    );
  });
});
