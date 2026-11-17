import { describe, expect, it } from "vitest";
import { githubSteps } from "../../../src/core/reset/github-steps.ts";
import type { ResetCtx } from "../../../src/core/reset/context.ts";
import type { GitHubClient, GitHubIssue } from "../../../src/core/github-client.ts";

class FakeGitHub {
  calls: string[] = [];
  constructor(private issues: GitHubIssue[]) {}
  async findIssuesByJiraKey(k: string) { this.calls.push(`findIssuesByJiraKey ${k}`); return this.issues; }
}
const fake = (issues: GitHubIssue[]) => new FakeGitHub(issues);
const ctx = (github: FakeGitHub | null, over: Partial<ResetCtx> = {}): ResetCtx => ({
  project: "proj", slug: "proj", ticket: "TARS-1", role: "all", config: null,
  jira: null, github: github as unknown as GitHubClient | null, openPrHeads: null, git: async () => "", sandbox: null, sandboxConfig: null,
  now: () => new Date(), closeRemote: false, ...over,
});

describe("github reset steps", () => {
  it("reports a closed-not-planned Issue and never acts", async () => {
    const gh = fake([
      { number: 585, url: "u585", state: "CLOSED", stateReason: "NOT_PLANNED" },
      { number: 590, url: "u590", state: "OPEN" },
      { number: 600, url: "u600", state: "CLOSED", stateReason: "COMPLETED" },
    ]);
    const steps = githubSteps(ctx(gh));
    expect(steps.map((s) => [s.area, s.name])).toEqual([["github", "mirror Issue"]]);
    const sv = await steps[0].survey();
    expect(sv).toEqual({ found: "#585 (closed, not planned), #590 (open), #600 (closed)", action: null });
    expect(gh.calls).toEqual(["findIssuesByJiraKey TARS-1"]);
  });

  it("reports none, and research scope also gets the row", async () => {
    expect(await githubSteps(ctx(fake([]), { role: "research" }))[0].survey()).toEqual({ found: "none", action: null });
  });

  it("dev scope has no github row", () => {
    expect(githubSteps(ctx(fake([]), { role: "dev" }))).toEqual([]);
  });

  it("no credentials needs you", async () => {
    expect(await githubSteps(ctx(null))[0].survey()).toMatchObject({ action: null, needsYou: "no credentials" });
  });
});
