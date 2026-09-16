import { describe, it, expect, vi } from "vitest";
import { RealGitHubClient, StubGitHubClient } from "../src/github-client.ts";

describe("StubGitHubClient", () => {
  it("throws on every method until wired with a real config", async () => {
    const client = new StubGitHubClient();
    await expect(client.findIssueByJiraKey("PROJ-1")).rejects.toThrow(/not configured/);
    await expect(
      client.createIssue({ title: "PROJ-1: x", body: "y", jiraKey: "PROJ-1" }),
    ).rejects.toThrow(/not configured/);
  });
});

describe("RealGitHubClient", () => {
  it("findIssueByJiraKey searches by title prefix and returns the first match", async () => {
    const execFn = vi.fn(async () =>
      JSON.stringify([{ number: 42, url: "https://github.com/org/repo/issues/42" }]),
    );
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.findIssueByJiraKey("PROJ-1");

    expect(issue).toEqual({ number: 42, url: "https://github.com/org/repo/issues/42" });
    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "list",
      "--repo",
      "org/repo",
      "--search",
      'in:title "PROJ-1:"',
      "--state",
      "all",
      "--json",
      "number,url",
    ]);
  });

  it("findIssueByJiraKey returns null when no issue matches", async () => {
    const execFn = vi.fn(async () => JSON.stringify([]));
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.findIssueByJiraKey("PROJ-1");

    expect(issue).toBeNull();
  });

  it("createIssue passes title/body and repo to gh issue create, returns the parsed issue", async () => {
    const execFn = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "create") {
        return "https://github.com/org/repo/issues/43\n";
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.createIssue({
      title: "PROJ-1: fix the thing",
      body: "## Overview\n...",
      jiraKey: "PROJ-1",
    });

    expect(issue).toEqual({ number: 43, url: "https://github.com/org/repo/issues/43" });
    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "create",
      "--repo",
      "org/repo",
      "--title",
      "PROJ-1: fix the thing",
      "--body",
      "## Overview\n...",
    ]);
  });

  it("createIssue throws a descriptive error when gh itself fails", async () => {
    const execFn = vi.fn(async () => {
      throw new Error("gh: authentication required");
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await expect(
      client.createIssue({ title: "PROJ-1: x", body: "y", jiraKey: "PROJ-1" }),
    ).rejects.toThrow(/authentication required/);
  });
});
