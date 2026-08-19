import { describe, it, expect } from "vitest";
import { buildRefineJql, buildDevJql } from "../src/jql.ts";
import type { Config } from "../src/types.ts";

function makeConfig(): Config {
  return {
    jira: {
      intakeEpics: ["EPIC-1", "EPIC-2"],
      readyEpic: "EPIC-READY",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: {
        refine: 'epic in ({epics}) AND status = "Backlog" ORDER BY created ASC',
        dev: 'epic = {epic} AND status = "Backlog" ORDER BY created ASC',
      },
      epicLinkField: "customfield_10014",
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}

describe("buildRefineJql", () => {
  it("substitutes intakeEpics into the refine template", () => {
    const jql = buildRefineJql(makeConfig());
    expect(jql).toContain("EPIC-1");
    expect(jql).toContain("EPIC-2");
    expect(jql).not.toContain("{epics}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    const jql = buildRefineJql(makeConfig());
    expect(jql).toContain("ORDER BY created ASC");
  });
});

describe("buildDevJql", () => {
  it("substitutes readyEpic into the dev template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("EPIC-READY");
    expect(jql).not.toContain("{epic}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("ORDER BY created ASC");
  });
});
