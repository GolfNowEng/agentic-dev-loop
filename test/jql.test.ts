import { describe, expect, it } from "vitest";
import { buildDevJql, buildRefineJql } from "../src/jql.js";
import type { Config } from "../src/types.js";

const config: Config = {
  jira: {
    intakeEpics: ["EPIC-1", "EPIC-2"],
    reviewEpic: "EPIC-REVIEW",
    readyEpic: "EPIC-READY",
    claimStatus: { from: "Ready", to: "In Progress" },
    pollJql: {
      refine: 'epic in ({epics}) AND status = "To Refine" ORDER BY created ASC',
      dev: 'epic = {readyEpic} AND status = "Ready" ORDER BY created ASC',
    },
    epicLinkField: "customfield_10014",
    statusNames: { bounced: "Blocked", prOpen: "In Progress" },
  },
  ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
  autoPromoteLabel: "auto-promote",
};

describe("buildRefineJql", () => {
  it("interpolates the intake epics into the refine template", () => {
    const jql = buildRefineJql(config);
    expect(jql).toContain("EPIC-1");
    expect(jql).toContain("EPIC-2");
    expect(jql).not.toContain("{epics}");
  });

  it("returns a non-empty string", () => {
    const jql = buildRefineJql(config);
    expect(typeof jql).toBe("string");
    expect(jql.length).toBeGreaterThan(0);
  });
});

describe("buildDevJql", () => {
  it("interpolates the ready epic into the dev template", () => {
    const jql = buildDevJql(config);
    expect(jql).toContain("EPIC-READY");
    expect(jql).not.toContain("{readyEpic}");
  });

  it("returns a non-empty string", () => {
    const jql = buildDevJql(config);
    expect(typeof jql).toBe("string");
    expect(jql.length).toBeGreaterThan(0);
  });
});
