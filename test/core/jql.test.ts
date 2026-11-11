import { describe, expect, it } from "vitest";
import { buildDevJql, buildRefineJql, excludeKeysFromJql } from "../../src/core/jql.ts";
import type { Config } from "../../src/core/types.ts";

const config: Config = {
  jira: {
    triggerLabel: "pipeline:research",
    handoffLabel: "pipeline:dev",
    repoLabel: "repo:webtarsthree",
    claimStatus: { from: "Ready", to: "In Progress" },
    pollJql: {
      refine:
        'labels = "{label}" AND labels = "{repoLabel}" AND status = "To Refine" ORDER BY created ASC',
      dev: 'labels = "{label}" AND labels = "{repoLabel}" AND assignee = "{assignee}" AND status != "{bouncedStatus}" AND status != "{prOpenStatus}" ORDER BY created ASC',
    },
    statusNames: { bounced: "Blocked", prOpen: "In Progress" },
    codeReviewFields: {
      piiField: "customfield_13504",
      piiNoImpactOptionId: "14310",
      qaNotesField: "customfield_14226",
    },
  },
  ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
  autoPromoteLabel: "auto-promote",
  targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
};

describe("buildRefineJql", () => {
  it("interpolates triggerLabel into the refine template", () => {
    const jql = buildRefineJql(config);
    expect(jql).toContain("pipeline:research");
    expect(jql).not.toContain("{label}");
  });

  it("interpolates repoLabel into the refine template, disambiguating repos that share one Jira project", () => {
    const jql = buildRefineJql(config);
    expect(jql).toContain("repo:webtarsthree");
    expect(jql).not.toContain("{repoLabel}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    expect(buildRefineJql(config)).toContain("ORDER BY created ASC");
  });

  it("returns a non-empty string", () => {
    const jql = buildRefineJql(config);
    expect(typeof jql).toBe("string");
    expect(jql.length).toBeGreaterThan(0);
  });
});

describe("buildDevJql", () => {
  it("interpolates handoffLabel and the assignee accountId into the dev template", () => {
    const jql = buildDevJql(config, "user-123");
    expect(jql).toContain("pipeline:dev");
    expect(jql).not.toContain("{label}");
    expect(jql).toContain("user-123");
    expect(jql).not.toContain("{assignee}");
  });

  it("interpolates repoLabel into the dev template", () => {
    const jql = buildDevJql(config, "user-123");
    expect(jql).toContain("repo:webtarsthree");
    expect(jql).not.toContain("{repoLabel}");
  });

  it("excludes tickets already in the bounced status, so a bounced ticket does not immediately re-match its own poll", () => {
    const jql = buildDevJql(config, "user-123");
    expect(jql).toContain('status != "Blocked"');
    expect(jql).not.toContain("{bouncedStatus}");
  });

  it("excludes tickets already in the prOpen status, so a landed ticket does not keep re-matching its own poll after PR creation", () => {
    const jql = buildDevJql(config, "user-123");
    expect(jql).toContain('status != "In Progress"');
    expect(jql).not.toContain("{prOpenStatus}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    expect(buildDevJql(config, "user-123")).toContain("ORDER BY created ASC");
  });

  it("returns a non-empty string", () => {
    const jql = buildDevJql(config, "user-123");
    expect(typeof jql).toBe("string");
    expect(jql.length).toBeGreaterThan(0);
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

  it("inserts before an upper-case ORDER BY in a real dev poll", () => {
    expect(excludeKeysFromJql(buildDevJql(config, "user-123"), ["PROJ-1"])).toMatch(
      /AND key not in \("PROJ-1"\) ORDER BY created ASC$/,
    );
  });
});
