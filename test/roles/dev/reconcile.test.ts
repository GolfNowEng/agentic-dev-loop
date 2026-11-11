import { describe, it, expect, vi } from "vitest";
import { reconcileMergedTickets, findOpenPrUrl, findLandedPrUrl } from "../../../src/roles/dev/reconcile.ts";
import type { JiraClient, JiraTicket } from "../../../src/core/jira-client.ts";
import type { GitHubClient } from "../../../src/core/github-client.ts";
import type { Config, RunLogLine } from "../../../src/core/types.ts";
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
  return { key: "PROJ-1", status: "Development Complete", assignee: "user-123", labels: [], ...overrides };
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

describe("findLandedPrUrl", () => {
  it("returns the PR of the latest landed line and ignores bounced lines", async () => {
    await withRunsLog(
      [
        makeRunLogLine({ outcome: "landed", pr: "https://github.com/org/repo/pull/9" }),
        makeRunLogLine({ outcome: "error", pr: null, failure_category: "agent_error" }),
        makeRunLogLine({ outcome: "bounced", pr: "https://github.com/org/repo/pull/77", failure_category: "blocked" }),
      ],
      async (p) => {
        expect(await findLandedPrUrl(p, "PROJ-1")).toBe("https://github.com/org/repo/pull/9");
      },
    );
  });

  it("returns null when the ticket never landed", async () => {
    await withRunsLog([makeRunLogLine({ outcome: "bounced", pr: null, failure_category: "spec_ambiguous" })], async (p) => {
      expect(await findLandedPrUrl(p, "PROJ-1")).toBeNull();
    });
  });
});

const NOW = new Date("2026-01-05T00:00:00Z");

function makeJira(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(),
    pollAllMatching: vi.fn(async () => []),
    claimTicket: vi.fn(),
    transitionStatus: vi.fn(),
    swapLabel: vi.fn(),
    removeLabel: vi.fn(async () => {}),
    assignTicket: vi.fn(),
    addComment: vi.fn(),
    closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
    ...overrides,
  };
}

function makeGh(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "https://github.com/org/repo/issues/42", state: "OPEN" as const })),
    addComment: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    closePr: vi.fn(async () => "already-closed" as const),
    ...overrides,
  };
}

const merged = () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T03:04:05Z" });
const open = () => JSON.stringify({ state: "OPEN", mergedAt: null });

describe("reconcileMergedTickets", () => {
  it("closes the mirror Issue and removes pipeline:dev for a landed ticket whose PR merged while the loop was off (Jira status is irrelevant, no JQL used)", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient = makeJira();
      const githubClient = makeGh();
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), runsLogPath, execGhPrView: vi.fn(async () => merged()), now: NOW,
      });

      expect(result).toEqual({ checked: 1, closed: ["PROJ-1"], errors: [] });
      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
      expect(jiraClient.removeLabel).toHaveBeenCalledWith("PROJ-1", "pipeline:dev");
      expect(jiraClient.pollAllMatching).not.toHaveBeenCalled();
    });
  });

  it("leaves a landed ticket whose PR is still open completely alone", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient = makeJira();
      const githubClient = makeGh();
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), runsLogPath, execGhPrView: vi.fn(async () => open()), now: NOW,
      });

      expect(result).toEqual({ checked: 1, closed: [], errors: [] });
      expect(githubClient.closeIssue).not.toHaveBeenCalled();
      expect(jiraClient.removeLabel).not.toHaveBeenCalled();
    });
  });

  it("when the recorded PR was closed unmerged but another PR for the ticket merged (TARS-1487: #470 closed, #476 merged), closes the Issue and removes pipeline:dev", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient = makeJira();
      const githubClient = makeGh();
      const execGhFindMergedPr = vi.fn(async () => ({ url: "https://github.com/org/repo/pull/12", mergedAt: "2026-01-03T04:05:06Z" }));
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), runsLogPath, now: NOW,
        execGhPrView: vi.fn(async () => JSON.stringify({ state: "CLOSED", mergedAt: null })),
        execGhFindMergedPr,
      });

      expect(execGhFindMergedPr).toHaveBeenCalledWith("PROJ-1");
      expect(result).toEqual({ checked: 1, closed: ["PROJ-1"], errors: [] });
      expect(githubClient.addComment).toHaveBeenCalledWith(42, expect.stringContaining("https://github.com/org/repo/pull/12"));
      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
      expect(jiraClient.removeLabel).toHaveBeenCalledWith("PROJ-1", "pipeline:dev");
    });
  });

  it("closed-unmerged PR with no other merged PR for the ticket is left alone", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient = makeJira();
      const githubClient = makeGh();
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), runsLogPath, now: NOW,
        execGhPrView: vi.fn(async () => JSON.stringify({ state: "CLOSED", mergedAt: null })),
        execGhFindMergedPr: vi.fn(async () => null),
      });

      expect(result).toEqual({ checked: 1, closed: [], errors: [] });
      expect(githubClient.closeIssue).not.toHaveBeenCalled();
      expect(jiraClient.removeLabel).not.toHaveBeenCalled();
    });
  });

  it("does not search for another PR while the recorded PR is still open", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const execGhFindMergedPr = vi.fn(async () => null);
      await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), runsLogPath, now: NOW,
        execGhPrView: vi.fn(async () => open()),
        execGhFindMergedPr,
      });
      expect(execGhFindMergedPr).not.toHaveBeenCalled();
    });
  });

  it("is a safe no-op when runs.jsonl has no landed tickets", async () => {
    await withRunsLog([makeRunLogLine({ outcome: "bounced", pr: null, failure_category: "spec_ambiguous" })], async (runsLogPath) => {
      const execGhPrView = vi.fn();
      const result = await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), runsLogPath, execGhPrView, now: NOW,
      });
      expect(result).toEqual({ checked: 0, closed: [], errors: [] });
      expect(execGhPrView).not.toHaveBeenCalled();
    });
  });

  it("ignores landed lines older than the 30-day window", async () => {
    await withRunsLog([makeRunLogLine({ started: "2025-11-01T00:00:00.000Z", ended: "2025-11-01T00:10:00.000Z" })], async (runsLogPath) => {
      const execGhPrView = vi.fn();
      const result = await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), runsLogPath, execGhPrView, now: NOW,
      });
      expect(result.checked).toBe(0);
      expect(execGhPrView).not.toHaveBeenCalled();
    });
  });

  it("checks each ticket once, using its latest landed PR", async () => {
    await withRunsLog(
      [
        makeRunLogLine({ pr: "https://github.com/org/repo/pull/1", ended: "2026-01-01T00:00:00.000Z" }),
        makeRunLogLine({ pr: "https://github.com/org/repo/pull/2", ended: "2026-01-02T00:00:00.000Z" }),
      ],
      async (runsLogPath) => {
        const execGhPrView = vi.fn(async () => open());
        const result = await reconcileMergedTickets({
          jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), runsLogPath, execGhPrView, now: NOW,
        });
        expect(result.checked).toBe(1);
        expect(execGhPrView).toHaveBeenCalledTimes(1);
        expect(execGhPrView).toHaveBeenCalledWith("https://github.com/org/repo/pull/2");
      },
    );
  });

  it("an already-closed mirror Issue gets no second comment or close, but the label is still removed", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient = makeJira();
      const githubClient = makeGh({
        findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "x", state: "CLOSED" as const })),
      });
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), runsLogPath, execGhPrView: vi.fn(async () => merged()), now: NOW,
      });

      expect(result.closed).toEqual(["PROJ-1"]);
      expect(githubClient.addComment).not.toHaveBeenCalled();
      expect(githubClient.closeIssue).not.toHaveBeenCalled();
      expect(jiraClient.removeLabel).toHaveBeenCalledWith("PROJ-1", "pipeline:dev");
    });
  });

  it("does not re-check a ticket already reconciled earlier in this process (shared `reconciled` set)", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const execGhPrView = vi.fn(async () => merged());
      const reconciled = new Set<string>();
      const deps = { jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), runsLogPath, execGhPrView, now: NOW, reconciled };

      await reconcileMergedTickets(deps);
      const second = await reconcileMergedTickets(deps);

      expect(execGhPrView).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ checked: 0, closed: [], errors: [] });
    });
  });

  it("a failed label removal does not block the Issue close and is not reported as an error", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient = makeJira({ removeLabel: vi.fn(async () => { throw new Error("jira 500"); }) });
      const githubClient = makeGh();
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), runsLogPath, execGhPrView: vi.fn(async () => merged()), now: NOW,
      });

      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
      expect(result).toEqual({ checked: 1, closed: ["PROJ-1"], errors: [] });
    });
  });

  it("a gh pr view failure for one ticket is recorded and does not stop the rest", async () => {
    await withRunsLog(
      [
        makeRunLogLine({ ticket: "PROJ-1", pr: "https://github.com/org/repo/pull/9" }),
        makeRunLogLine({ ticket: "PROJ-2", pr: "https://github.com/org/repo/pull/10" }),
      ],
      async (runsLogPath) => {
        const execGhPrView = vi.fn(async (url: string) => {
          if (url.endsWith("/9")) throw new Error("gh: network error");
          return merged();
        });
        const result = await reconcileMergedTickets({
          jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), runsLogPath, execGhPrView, now: NOW,
        });

        expect(result.checked).toBe(2);
        expect(result.closed).toEqual(["PROJ-2"]);
        expect(result.errors).toEqual([{ ticket: "PROJ-1", message: expect.stringContaining("network error") }]);
      },
    );
  });
});

describe("reconcileMergedTickets -- close comment", () => {
  it("posts the templated comment on the mirror Issue before closing it", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const githubClient = makeGh();
      await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient, config: makeConfig(), runsLogPath, execGhPrView: vi.fn(async () => merged()), now: NOW,
      });

      const [issueNumber, body] = (githubClient.addComment as ReturnType<typeof vi.fn>).mock.calls[0] as [number, string];
      expect(issueNumber).toBe(42);
      expect(body).toBe(
        [
          "**Closed automatically by dev-loop**",
          "",
          "PR: https://github.com/org/repo/pull/9",
          "Merged: 2026-01-02 03:04 UTC",
          "Ticket: PROJ-1",
          "Reason: PR merged, closed as completed",
        ].join("\n"),
      );
      const c = (githubClient.addComment as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const x = (githubClient.closeIssue as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(c).toBeLessThan(x);
    });
  });

  it("still closes the Issue, with no error, when posting the comment fails", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const githubClient = makeGh({ addComment: vi.fn(async () => { throw new Error("rate limited"); }) });
      const result = await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient, config: makeConfig(), runsLogPath, execGhPrView: vi.fn(async () => merged()), now: NOW,
      });
      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
      expect(result.errors).toEqual([]);
    });
  });
});
