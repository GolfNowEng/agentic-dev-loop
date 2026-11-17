import { describe, expect, it } from "vitest";
import { buildMirrorIssueBody, pickMirrorIssue } from "../../../src/roles/research/mirror-issue.ts";
import type { GitHubIssue } from "../../../src/core/github-client.ts";

const issue = (number: number, state: "OPEN" | "CLOSED", stateReason: GitHubIssue["stateReason"] = null): GitHubIssue => ({
  number,
  url: `https://example.test/issues/${number}`,
  state,
  stateReason,
});

describe("pickMirrorIssue", () => {
  it("reuses the open Issue", () => {
    const open = issue(7, "OPEN");
    expect(pickMirrorIssue([issue(3, "CLOSED", "NOT_PLANNED"), open])).toEqual({
      reuse: open,
      previous: [issue(3, "CLOSED", "NOT_PLANNED")],
    });
  });

  it("never reuses a closed not-planned Issue and lists it as previous, newest first", () => {
    const r = pickMirrorIssue([issue(3, "CLOSED", "NOT_PLANNED"), issue(9, "CLOSED", "NOT_PLANNED")]);
    expect(r.reuse).toBeNull();
    expect(r.previous.map((i) => i.number)).toEqual([9, 3]);
  });

  it("reuses a closed completed Issue", () => {
    const done = issue(5, "CLOSED", "COMPLETED");
    expect(pickMirrorIssue([issue(2, "CLOSED", "NOT_PLANNED"), done]).reuse).toBe(done);
  });

  it("reuses the newest eligible Issue", () => {
    expect(pickMirrorIssue([issue(5, "CLOSED", "COMPLETED"), issue(8, "OPEN")]).reuse?.number).toBe(8);
  });

  it("returns nothing for no Issues", () => {
    expect(pickMirrorIssue([])).toEqual({ reuse: null, previous: [] });
  });
});

describe("buildMirrorIssueBody", () => {
  it("links each previous attempt, one line each, at the end", () => {
    const body = buildMirrorIssueBody("TARS-1", "https://jira.example", [issue(9, "CLOSED", "NOT_PLANNED"), issue(3, "CLOSED", "NOT_PLANNED")]);
    expect(body.endsWith("Previous attempt: #9\nPrevious attempt: #3")).toBe(true);
    expect(body).toContain("[TARS-1](https://jira.example/browse/TARS-1)");
  });

  it("has no Previous attempt line when there is none", () => {
    expect(buildMirrorIssueBody("TARS-1", "https://jira.example", [])).not.toContain("Previous attempt");
  });
});
