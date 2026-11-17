import { describe, it, expect, vi } from "vitest";
import {
  RealGitHubClient,
  StubGitHubClient,
  realExecGhFindMergedPr,
  realExecGhPrView,
  realDefaultBranch,
  containsTicketToken,
  realFindOpenPrUrl,
  realOpenPrHeads,
} from "../../src/core/github-client.ts";

describe("StubGitHubClient", () => {
  it("throws on every method until wired with a real config", async () => {
    const client = new StubGitHubClient();
    await expect(client.findIssueByJiraKey("PROJ-1")).rejects.toThrow(/not configured/);
    await expect(
      client.createIssue({ title: "PROJ-1: x", body: "y", jiraKey: "PROJ-1" }),
    ).rejects.toThrow(/not configured/);
    await expect(client.addComment(42, "hello")).rejects.toThrow(/not configured/);
    await expect(client.closeIssue(42, "completed")).rejects.toThrow(/not configured/);
    await expect(client.closePr("https://github.com/org/repo/pull/1")).rejects.toThrow(
      /not configured/,
    );
  });
});

describe("RealGitHubClient", () => {
  it("findIssueByJiraKey searches by title prefix and returns the first match", async () => {
    const execFn = vi.fn(async () =>
      JSON.stringify([{ number: 42, url: "https://github.com/org/repo/issues/42", state: "CLOSED" }]),
    );
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.findIssueByJiraKey("PROJ-1");

    expect(issue).toEqual({ number: 42, url: "https://github.com/org/repo/issues/42", state: "CLOSED", stateReason: null });
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
      "number,url,state,stateReason",
    ]);
  });

  it("findIssueByJiraKey returns null when no issue matches", async () => {
    const execFn = vi.fn(async () => JSON.stringify([]));
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.findIssueByJiraKey("PROJ-1");

    expect(issue).toBeNull();
  });

  it("createIssue passes title/body and repo to gh issue create, returns the parsed issue (always OPEN)", async () => {
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

    expect(issue).toEqual({ number: 43, url: "https://github.com/org/repo/issues/43", state: "OPEN" });
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

  it("createIssue throws when gh's output is not an issue URL", async () => {
    const execFn = vi.fn(async () => "something unexpected\n");
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await expect(
      client.createIssue({ title: "PROJ-1: x", body: "y", jiraKey: "PROJ-1" }),
    ).rejects.toThrow(/could not parse an issue number/);
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

  it("closeIssue rethrows a genuinely different gh failure", async () => {
    const execFn = vi.fn(async () => {
      throw new Error("gh: authentication required");
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await expect(client.closeIssue(42, "completed")).rejects.toThrow(/authentication required/);
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

describe("realExecGhFindMergedPr (moved from roles/dev/reconcile.ts)", () => {
  const pr = (o: Partial<{ url: string; mergedAt: string; title: string; headRefName: string; baseRefName: string }>) => ({
    url: "https://github.com/org/repo/pull/1",
    mergedAt: "2026-01-01T00:00:00Z",
    title: "x",
    headRefName: "feature/x",
    baseRefName: "main",
    ...o,
  });

  it("asks gh for baseRefName and returns it with the match", async () => {
    const exec = vi.fn(async () => JSON.stringify([pr({ headRefName: "feature/TARS-1-x" })]));
    const found = await realExecGhFindMergedPr("org/repo", exec)("TARS-1");

    expect(found).toEqual({ url: "https://github.com/org/repo/pull/1", mergedAt: "2026-01-01T00:00:00Z", baseRefName: "main" });
    const args = exec.mock.calls[0]![0] as string[];
    expect(args).toEqual(expect.arrayContaining(["pr", "list", "-R", "org/repo", "--state", "merged", "--search", "TARS-1"]));
    expect(args[args.indexOf("--json") + 1]).toBe("url,mergedAt,title,headRefName,baseRefName");
  });

  it("keeps the whole-token match: TARS-1 never matches TARS-12", async () => {
    const exec = vi.fn(async () => JSON.stringify([pr({ headRefName: "feature/TARS-12-x", title: "TARS-12: y" })]));
    expect(await realExecGhFindMergedPr("org/repo", exec)("TARS-1")).toBeNull();
  });

  it("with a baseRefName option, ignores merges into other bases (latest matching base wins)", async () => {
    const exec = vi.fn(async () =>
      JSON.stringify([
        pr({ url: "u-release", headRefName: "TARS-1", baseRefName: "release", mergedAt: "2026-02-01T00:00:00Z" }),
        pr({ url: "u-main", headRefName: "TARS-1", baseRefName: "main", mergedAt: "2026-01-01T00:00:00Z" }),
      ]),
    );
    expect((await realExecGhFindMergedPr("org/repo", exec)("TARS-1", { baseRefName: "main" }))?.url).toBe("u-main");
    expect((await realExecGhFindMergedPr("org/repo", exec)("TARS-1"))?.url).toBe("u-release");
  });
});

describe("containsTicketToken", () => {
  it("matches whole tokens only", () => {
    expect(containsTicketToken("feature/TARS-1-x", "TARS-1")).toBe(true);
    expect(containsTicketToken("feature/TARS-12-x", "TARS-1")).toBe(false);
  });

  it("treats regex metacharacters in the key literally", () => {
    expect(containsTicketToken("feature/TARSX1", "TARS.1")).toBe(false);
    expect(containsTicketToken("x (y", "(")).toBe(true);
  });
});

describe("realExecGhPrView (moved from roles/dev/reconcile.ts)", () => {
  it("runs gh pr view <url> --json state,mergedAt,baseRefName and returns stdout", async () => {
    const exec = vi.fn(async () => '{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z"}');
    const out = await realExecGhPrView(exec)("https://github.com/org/repo/pull/9");

    expect(out).toBe('{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z"}');
    expect(exec).toHaveBeenCalledWith(["pr", "view", "https://github.com/org/repo/pull/9", "--json", "state,mergedAt,baseRefName"]);
  });
});

describe("realDefaultBranch", () => {
  it("asks gh for the repo's default branch and trims the output", async () => {
    const exec = vi.fn(async () => "main\n");
    expect(await realDefaultBranch("org/repo", exec)).toBe("main");
    expect(exec).toHaveBeenCalledWith(["repo", "view", "org/repo", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  });

  it("rejects a repo that isn't owner/name without calling gh", async () => {
    const exec = vi.fn(async () => "main");
    for (const bad of ["org", "org/repo/x", "org/re po", "-R/x", "org/$(rm)", ""]) {
      await expect(realDefaultBranch(bad, exec), bad).rejects.toThrow(/invalid repo/i);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("throws when gh returns an empty branch name", async () => {
    await expect(realDefaultBranch("org/repo", vi.fn(async () => "\n"))).rejects.toThrow(/default branch/i);
  });
});

describe("core never imports from roles", () => {
  it("no src/core file imports a src/roles module", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../../src/core/", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /from\s+["'][^"']*roles\//.test(readFileSync(new URL(f, dir), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("realFindOpenPrUrl", () => {
  it("lists open PRs in the repo and returns the first whose head branch or title has the key as a whole token", async () => {
    const exec = vi.fn(async () =>
      JSON.stringify([
        { url: "https://github.com/org/repo/pull/2", title: "TARS-12: other", headRefName: "feature/TARS-12" },
        { url: "https://github.com/org/repo/pull/3", title: "x", headRefName: "feature/TARS-1-thing" },
      ]),
    );
    expect(await realFindOpenPrUrl("org/repo", exec)("TARS-1")).toBe("https://github.com/org/repo/pull/3");
    const args = exec.mock.calls[0]![0] as string[];
    expect(args).toEqual(expect.arrayContaining(["pr", "list", "-R", "org/repo", "--state", "open", "--search", "TARS-1"]));
  });

  it("null when nothing matches; refuses an invalid key without calling gh", async () => {
    const exec = vi.fn(async () => "[]");
    expect(await realFindOpenPrUrl("org/repo", exec)("TARS-1")).toBeNull();
    await expect(realFindOpenPrUrl("org/repo", exec)("TARS-1 --x")).rejects.toThrow(/invalid ticket key/);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("findIssuesByJiraKey / findIssueByJiraKey preference", () => {
  const entries = [
    { number: 9, url: "u9", state: "CLOSED", stateReason: "COMPLETED" },
    { number: 3, url: "u3", state: "CLOSED", stateReason: "NOT_PLANNED" },
    { number: 5, url: "u5", state: "OPEN", stateReason: null },
  ];

  it("findIssuesByJiraKey returns every match with stateReason, ascending", async () => {
    const execFn = vi.fn(async () => JSON.stringify(entries));
    const out = await new RealGitHubClient({ repo: "org/repo" }, execFn).findIssuesByJiraKey("PROJ-1");
    expect(out.map((i) => i.number)).toEqual([3, 5, 9]);
    expect(out[0]).toEqual({ number: 3, url: "u3", state: "CLOSED", stateReason: "NOT_PLANNED" });
    expect(out[1]!.stateReason).toBeNull();
    expect(execFn.mock.calls[0]![0]).toContain("number,url,state,stateReason");
  });

  it("findIssueByJiraKey prefers an open Issue over a closed one", async () => {
    const execFn = vi.fn(async () => JSON.stringify(entries));
    const issue = await new RealGitHubClient({ repo: "org/repo" }, execFn).findIssueByJiraKey("PROJ-1");
    expect(issue?.number).toBe(5);
  });

  it("stub throws not-configured", async () => {
    await expect(new StubGitHubClient().findIssuesByJiraKey("PROJ-1")).rejects.toThrow(/not configured/);
  });
});

describe("realOpenPrHeads", () => {
  it("keeps only <KEY>- heads", async () => {
    const exec = vi.fn(async () =>
      JSON.stringify([
        { headRefName: "TARS-1-a", url: "u1" },
        { headRefName: "TARS-10-b", url: "u2" },
        { headRefName: "main", url: "u3" },
      ]),
    );
    const out = await realOpenPrHeads("org/repo", exec)("TARS-1");
    expect(out).toEqual([{ head: "TARS-1-a", url: "u1" }]);
    expect(exec).toHaveBeenCalledWith([
      "pr", "list", "--repo", "org/repo", "--state", "open", "--search", "TARS-1 in:title,body", "--json", "headRefName,url",
    ]);
  });
});
