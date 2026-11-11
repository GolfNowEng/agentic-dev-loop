import { describe, it, expect, vi } from "vitest";
import { RealGitHubClient, StubGitHubClient } from "../../src/core/github-client.ts";

describe("StubGitHubClient", () => {
  it("throws on every method until wired with a real config", async () => {
    const client = new StubGitHubClient();
    await expect(client.findIssueByJiraKey("PROJ-1")).rejects.toThrow(/not configured/);
    await expect(client.addComment(42, "hello")).rejects.toThrow(/not configured/);
    await expect(client.closeIssue(42, "completed")).rejects.toThrow(/not configured/);
  });
});

describe("RealGitHubClient", () => {
  it("findIssueByJiraKey searches by title prefix and returns the first match", async () => {
    const execFn = vi.fn(async () =>
      JSON.stringify([{ number: 42, url: "https://github.com/org/repo/issues/42", state: "CLOSED" }]),
    );
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.findIssueByJiraKey("PROJ-1");

    expect(issue).toEqual({ number: 42, url: "https://github.com/org/repo/issues/42", state: "CLOSED" });
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
      "number,url,state",
    ]);
  });

  it("findIssueByJiraKey returns null when no issue matches", async () => {
    const execFn = vi.fn(async () => JSON.stringify([]));
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.findIssueByJiraKey("PROJ-1");

    expect(issue).toBeNull();
  });

  it("addComment posts to the given issue number via gh issue comment", async () => {
    const execFn = vi.fn(async () => "https://github.com/org/repo/issues/42#issuecomment-1\n");
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await client.addComment(42, "bounced (spec_ambiguous): missing AC detail");

    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "comment",
      "42",
      "--repo",
      "org/repo",
      "--body",
      "bounced (spec_ambiguous): missing AC detail",
    ]);
  });

  it("closeIssue closes with the given state_reason via --reason", async () => {
    const execFn = vi.fn(async () => "");
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await client.closeIssue(42, "completed");

    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "close",
      "42",
      "--repo",
      "org/repo",
      "--reason",
      "completed",
    ]);
  });

  it("closeIssue maps not_planned to gh's own 'not planned' reason string (gh's flag value has a space, unlike the API's state_reason)", async () => {
    const execFn = vi.fn(async () => "");
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await client.closeIssue(42, "not_planned");

    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "close",
      "42",
      "--repo",
      "org/repo",
      "--reason",
      "not planned",
    ]);
  });

  it("addComment throws a descriptive error when gh itself fails", async () => {
    const execFn = vi.fn(async () => {
      throw new Error("gh: authentication required");
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await expect(client.addComment(42, "x")).rejects.toThrow(/authentication required/);
  });

  it("closeIssue is a safe no-op (does not throw) when gh reports the issue is already closed", async () => {
    const execFn = vi.fn(async () => {
      throw new Error("GraphQL: Issue is already closed (closeIssue)");
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await expect(client.closeIssue(42, "completed")).resolves.toBeUndefined();
  });

  it("closePr closes the PR at the given URL via gh pr close, no number parsing", async () => {
    const execFn = vi.fn(async () => "");
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const result = await client.closePr("https://github.com/org/repo/pull/431");

    expect(result).toBe("closed");
    expect(execFn).toHaveBeenCalledWith([
      "pr",
      "close",
      "https://github.com/org/repo/pull/431",
      "--repo",
      "org/repo",
    ]);
  });

  it("closePr returns 'already-closed' when gh reports the PR is already closed (verified live: gh issue close 431, exit 0, message contains 'already closed')", async () => {
    const execFn = vi.fn(async () => {
      throw new Error(
        "! Pull request org/repo#431 (some title) is already closed",
      );
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const result = await client.closePr("https://github.com/org/repo/pull/431");

    expect(result).toBe("already-closed");
  });

  it("closePr returns 'already-closed' when gh reports the PR was already merged (verified live: gh pr close 429, exit 1, message contains 'already merged' -- a different code path from 'already closed' but the same correct outcome for a reset)", async () => {
    const execFn = vi.fn(async () => {
      throw new Error(
        "X Pull request org/repo#429 (some title) can't be closed because it was already merged",
      );
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const result = await client.closePr("https://github.com/org/repo/pull/429");

    expect(result).toBe("already-closed");
  });

  it("closePr rethrows a genuinely different gh failure (not idempotency-related)", async () => {
    const execFn = vi.fn(async () => {
      throw new Error("gh: authentication required");
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await expect(client.closePr("https://github.com/org/repo/pull/1")).rejects.toThrow(
      /authentication required/,
    );
  });
});
