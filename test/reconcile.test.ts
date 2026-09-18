import { describe, it, expect, vi } from "vitest";
import { reconcileMergedTickets, findOpenPrUrl } from "../src/reconcile.ts";
import type { JiraClient, JiraTicket } from "../src/jira-client.ts";
import type { GitHubClient } from "../src/github-client.ts";
import type { Config, RunLogLine } from "../src/types.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeConfig(): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      repoLabel: "repo:webtarsthree",
      claimStatus: { from: "Ready", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" ORDER BY created ASC',
        dev: 'labels = "{label}" AND status != "{bouncedStatus}" ORDER BY created ASC',
      },
      statusNames: { bounced: "Blocked", prOpen: "Code Review" },
      codeReviewFields: {
        piiField: "customfield_13504",
        piiNoImpactOptionId: "14310",
        qaNotesField: "customfield_14226",
      },
    },
    github: { repo: "org/repo" },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}

function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return { key: "PROJ-1", status: "Code Review", assignee: "user-123", ...overrides };
}

function makeRunLogLine(overrides: Partial<RunLogLine> = {}): RunLogLine {
  return {
    ticket: "PROJ-1",
    skill: "ticket-to-pr",
    skill_version: "abc1234",
    model: "sonnet",
    started: "2026-01-01T00:00:00.000Z",
    ended: "2026-01-01T00:10:00.000Z",
    outcome: "landed",
    phase_reached: "pr",
    red_confirmed: true,
    verify_loops: 1,
    retries: 0,
    failure_category: null,
    detail: "landed",
    pr: "https://github.com/org/repo/pull/9",
    cost_usd: 1.0,
    tokens: { in: 100, out: 50 },
    ...overrides,
  };
}

async function withRunsLog(lines: RunLogLine[], fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "reconcile-test-"));
  const path = join(dir, "runs.jsonl");
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("findOpenPrUrl", () => {
  it("returns the PR URL from a 'landed' line", async () => {
    await withRunsLog(
      [makeRunLogLine({ outcome: "landed", pr: "https://github.com/org/repo/pull/9" })],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBe("https://github.com/org/repo/pull/9");
      },
    );
  });

  it("returns the PR URL from a 'bounced' line too -- intake finding a pre-existing PR still counts as an open PR to close on reset", async () => {
    await withRunsLog(
      [
        makeRunLogLine({
          outcome: "bounced",
          pr: "https://github.com/org/repo/pull/431",
          failure_category: "blocked",
        }),
      ],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBe("https://github.com/org/repo/pull/431");
      },
    );
  });

  it("returns the most recent matching line's PR when several exist, landed and bounced mixed", async () => {
    await withRunsLog(
      [
        makeRunLogLine({ outcome: "landed", pr: "https://github.com/org/repo/pull/1", started: "2026-01-01T00:00:00.000Z" }),
        makeRunLogLine({ outcome: "bounced", pr: "https://github.com/org/repo/pull/1", failure_category: "blocked", started: "2026-01-01T00:05:00.000Z" }),
        makeRunLogLine({ outcome: "bounced", pr: "https://github.com/org/repo/pull/1", failure_category: "blocked", started: "2026-01-01T00:10:00.000Z" }),
      ],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBe("https://github.com/org/repo/pull/1");
      },
    );
  });

  it("ignores a bounced line with no PR (a genuine blocker, never opened a PR)", async () => {
    await withRunsLog(
      [
        makeRunLogLine({
          outcome: "bounced",
          pr: null,
          failure_category: "spec_ambiguous",
        }),
      ],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBeNull();
      },
    );
  });

  it("returns null when no line matches the ticket key", async () => {
    await withRunsLog(
      [makeRunLogLine({ ticket: "PROJ-OTHER" })],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBeNull();
      },
    );
  });

  it("returns null when the runs.jsonl file doesn't exist", async () => {
    const url = await findOpenPrUrl("/nonexistent/runs.jsonl", "PROJ-1");
    expect(url).toBeNull();
  });
});

describe("reconcileMergedTickets", () => {
  it("finds a Code-Review ticket whose PR merged, and closes the mirror Issue", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => [makeTicket()]),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
        closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
      };
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "https://github.com/org/repo/issues/42" })),
        addComment: vi.fn(),
        closeIssue: vi.fn(async () => {}),
        closePr: vi.fn(async () => "already-closed" as const),
      };
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" }));

      const result = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config: makeConfig(),
        runsLogPath,
        execGhPrView,
      });

      expect(result).toEqual({ checked: 1, closed: ["PROJ-1"], errors: [] });
      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
    });
  });

  it("does nothing for a Code-Review ticket whose PR is still open", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => [makeTicket()]),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
        closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
      };
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "x" })),
        addComment: vi.fn(),
        closeIssue: vi.fn(),
        closePr: vi.fn(async () => "already-closed" as const),
      };
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "OPEN", mergedAt: null }));

      const result = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config: makeConfig(),
        runsLogPath,
        execGhPrView,
      });

      expect(result).toEqual({ checked: 1, closed: [], errors: [] });
      expect(githubClient.closeIssue).not.toHaveBeenCalled();
    });
  });

  it("is a safe no-op when no ticket is at Code Review", async () => {
    await withRunsLog([], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => []),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
        closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
      };
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(),
        addComment: vi.fn(),
        closeIssue: vi.fn(),
        closePr: vi.fn(async () => "already-closed" as const),
      };
      const execGhPrView = vi.fn();

      const result = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config: makeConfig(),
        runsLogPath,
        execGhPrView,
      });

      expect(result).toEqual({ checked: 0, closed: [], errors: [] });
      expect(execGhPrView).not.toHaveBeenCalled();
    });
  });

  it("skips a Code-Review ticket with no 'landed' line in runs.jsonl (no PR URL to check), recording it as an error, not a crash", async () => {
    await withRunsLog([], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => [makeTicket()]),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
        closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
      };
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(),
        addComment: vi.fn(),
        closeIssue: vi.fn(),
        closePr: vi.fn(async () => "already-closed" as const),
      };
      const execGhPrView = vi.fn();

      const result = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config: makeConfig(),
        runsLogPath,
        execGhPrView,
      });

      expect(result.checked).toBe(1);
      expect(result.closed).toEqual([]);
      expect(result.errors).toEqual([
        { ticket: "PROJ-1", message: expect.stringContaining("no landed/bounced run with a PR found") },
      ]);
      expect(execGhPrView).not.toHaveBeenCalled();
    });
  });

  it("re-running on an already-closed mirror Issue is a safe no-op -- idempotency guard", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => [makeTicket()]),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
        closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
      };
      // closeIssue itself is already a safe no-op on an already-closed
      // issue (see Task 3) -- this test just confirms reconcile still
      // reports the ticket as "closed" (its merge was confirmed) even on
      // a second pass, and doesn't error just because gh reports it as
      // already closed.
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "x" })),
        addComment: vi.fn(),
        closeIssue: vi.fn(async () => {}), // real RealGitHubClient already swallows "already closed"
        closePr: vi.fn(async () => "already-closed" as const),
      };
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" }));

      const first = await reconcileMergedTickets({ jiraClient, githubClient, config: makeConfig(), runsLogPath, execGhPrView });
      const second = await reconcileMergedTickets({ jiraClient, githubClient, config: makeConfig(), runsLogPath, execGhPrView });

      expect(first.closed).toEqual(["PROJ-1"]);
      expect(second.closed).toEqual(["PROJ-1"]);
      expect(second.errors).toEqual([]);
    });
  });

  it("a gh pr view failure for one ticket is recorded as an error and does not stop the pass from checking the rest", async () => {
    await withRunsLog(
      [
        makeRunLogLine({ ticket: "PROJ-1", pr: "https://github.com/org/repo/pull/9" }),
        makeRunLogLine({ ticket: "PROJ-2", pr: "https://github.com/org/repo/pull/10" }),
      ],
      async (runsLogPath) => {
        const jiraClient: JiraClient = {
          pollOldestMatching: vi.fn(),
          pollAllMatching: vi.fn(async () => [makeTicket({ key: "PROJ-1" }), makeTicket({ key: "PROJ-2" })]),
          claimTicket: vi.fn(),
          transitionStatus: vi.fn(),
          swapLabel: vi.fn(),
          assignTicket: vi.fn(),
          addComment: vi.fn(),
          closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
        };
        const githubClient: GitHubClient = {
          findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "x" })),
          addComment: vi.fn(),
          closeIssue: vi.fn(async () => {}),
          closePr: vi.fn(async () => "already-closed" as const),
        };
        const execGhPrView = vi.fn(async (url: string) => {
          if (url.includes("/9")) throw new Error("gh: network error");
          return JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" });
        });

        const result = await reconcileMergedTickets({
          jiraClient,
          githubClient,
          config: makeConfig(),
          runsLogPath,
          execGhPrView,
        });

        expect(result.checked).toBe(2);
        expect(result.closed).toEqual(["PROJ-2"]);
        expect(result.errors).toEqual([{ ticket: "PROJ-1", message: expect.stringContaining("network error") }]);
      },
    );
  });
});
