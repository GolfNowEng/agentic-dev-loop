import { describe, expect, it } from "vitest";
import { buildPollJql, excludeIdsFromJql, excludeKeysFromJql } from "../../src/core/jql.ts";
import { roleView } from "../../src/core/config.ts";
import { makeV2Config } from "../fixtures/config.ts";

const ASSIGNEE = "712020:abc-DEF_123";

describe("buildPollJql", () => {
  it("fills every placeholder: {label} {repoLabel} {assignee} {bouncedStatus} {prOpenStatus}", () => {
    const view = roleView(
      makeV2Config((c) => {
        c.roles.dev.pollJql =
          'labels = "{label}" AND labels = "{repoLabel}" AND assignee = "{assignee}" AND status != "{bouncedStatus}" AND status != "{prOpenStatus}" ORDER BY created ASC';
      }),
      "dev",
    );
    expect(buildPollJql(view, { assigneeAccountId: ASSIGNEE })).toBe(
      `labels = "pipeline:v2.0.0:dev" AND labels = "repo:org-repo" AND assignee = "${ASSIGNEE}" AND status != "Blocked" AND status != "Code Review" ORDER BY created ASC`,
    );
  });

  it("fills the research role's {label} with its own trigger label", () => {
    const jql = buildPollJql(roleView(makeV2Config(), "research"), { assigneeAccountId: ASSIGNEE });
    expect(jql).toBe('labels = "pipeline:v2.0.0" AND labels = "repo:org-repo" AND status = "To Do" ORDER BY created ASC');
  });

  it("fills a placeholder that appears more than once", () => {
    const view = roleView(makeV2Config((c) => (c.roles.research.pollJql = 'labels = "{label}" OR labels = "{label}"')), "research");
    expect(buildPollJql(view, { assigneeAccountId: ASSIGNEE })).toBe(
      'labels = "pipeline:v2.0.0" OR labels = "pipeline:v2.0.0"',
    );
  });

  it("throws on a placeholder it doesn't fill", () => {
    const view = roleView(makeV2Config((c) => (c.roles.research.pollJql = 'labels = "{label}" AND sprint = "{sprint}"')), "research");
    expect(() => buildPollJql(view, { assigneeAccountId: ASSIGNEE })).toThrow(/\{sprint\}/);
  });

  it.each(['abc" OR project = X', "abc\\", "abc\nd", "", "a b"])(
    "throws on an assignee account id outside [A-Za-z0-9:_-]+ (%j) when the template uses {assignee}",
    (bad) => {
      const view = roleView(
        makeV2Config((c) => (c.roles.dev.pollJql = 'labels = "{label}" AND assignee = "{assignee}"')),
        "dev",
      );
      expect(() => buildPollJql(view, { assigneeAccountId: bad })).toThrow(/assignee/i);
    },
  );

  it("does not validate the assignee when the template has no {assignee} (it is never interpolated)", () => {
    const view = roleView(makeV2Config(), "research");
    expect(view.pollJql).not.toContain("{assignee}");
    expect(buildPollJql(view, { assigneeAccountId: "" })).toBe(
      'labels = "pipeline:v2.0.0" AND labels = "repo:org-repo" AND status = "To Do" ORDER BY created ASC',
    );
  });

  it("does not re-expand a placeholder that appears inside a substituted value", () => {
    const view = roleView(makeV2Config((c) => (c.jira.repoLabel = "repo:{label}")), "research");
    expect(buildPollJql(view, { assigneeAccountId: ASSIGNEE })).toContain('labels = "repo:{label}"');
  });
});

describe("excludeKeysFromJql", () => {
  it("returns the jql unchanged when there are no keys to exclude", () => {
    expect(excludeKeysFromJql('labels = "x"', [])).toBe('labels = "x"');
  });

  it("appends a key-not-in clause", () => {
    expect(excludeKeysFromJql('labels = "x"', ["AB-1", "AB-2"])).toBe(
      'labels = "x" AND key not in ("AB-1","AB-2")',
    );
  });

  it("inserts the clause before ORDER BY, case-insensitively", () => {
    expect(excludeKeysFromJql('labels = "x" order by created ASC', ["AB-1"])).toBe(
      'labels = "x" AND key not in ("AB-1") order by created ASC',
    );
  });

  it("inserts before an upper-case ORDER BY in a real dev poll", () => {
    const jql = buildPollJql(roleView(makeV2Config(), "dev"), { assigneeAccountId: ASSIGNEE });
    expect(excludeKeysFromJql(jql, ["PROJ-1"])).toMatch(/AND key not in \("PROJ-1"\) ORDER BY created ASC$/);
  });

  it.each(['PROJ-1") OR key in ("X-1', "proj-1", "PROJ-", "P-1", "PROJ-1\n", "PROJ_1"])(
    "throws on a key that is not a Jira issue key (%j), never interpolating it",
    (bad) => {
      expect(() => excludeKeysFromJql('labels = "x"', ["PROJ-2", bad])).toThrow(/ticket key/i);
    },
  );

  it("accepts keys with digits and underscores in the project part", () => {
    expect(excludeKeysFromJql('labels = "x"', ["MC2_X-10"])).toBe('labels = "x" AND key not in ("MC2_X-10")');
  });
});

describe("excludeIdsFromJql", () => {
  it("returns the jql unchanged when there are no ids", () => {
    expect(excludeIdsFromJql('labels = "x"', [])).toBe('labels = "x"');
  });

  it("appends an id-not-in clause before ORDER BY", () => {
    expect(excludeIdsFromJql('labels = "x" ORDER BY created ASC', ["10001", "42"])).toBe(
      'labels = "x" AND id not in (10001,42) ORDER BY created ASC',
    );
  });

  it.each(["10001) OR (1", "", "-1", "1.5", "0x1", "1\n"])("throws on a non-numeric id (%j), never interpolating it", (bad) => {
    expect(() => excludeIdsFromJql('labels = "x"', ["1", bad])).toThrow(/issue id/i);
  });
});
