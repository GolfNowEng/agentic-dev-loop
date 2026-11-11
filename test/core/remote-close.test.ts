import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planRemoteClose,
  executeRemoteClose,
  describeRemoteClosePlan,
  describeRemoteCloseSummary,
} from "../../src/core/remote-close.ts";
import type { JiraClient } from "../../src/core/jira-client.ts";
import type { GitHubClient } from "../../src/core/github-client.ts";

function makeMockJiraClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => null),
    pollAllMatching: vi.fn(async () => []),
    claimTicket: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => {}),
    swapLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    assignTicket: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
    ...overrides,
  };
}

function makeMockGitHubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    findIssueByJiraKey: vi.fn(async () => ({
      number: 42,
      url: "https://github.com/org/repo/issues/42",
      state: "OPEN" as const,
    })),
    createIssue: vi.fn(async () => ({
      number: 42,
      url: "https://github.com/org/repo/issues/42",
      state: "OPEN" as const,
    })),
    addComment: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    closePr: vi.fn(async () => "already-closed" as const),
    ...overrides,
  };
}

async function withRunsLog(lines: object[], fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "remote-close-test-"));
  const path = join(dir, "runs.jsonl");
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("planRemoteClose", () => {
  it("recovers the PR URL from a landed run line", async () => {
    await withRunsLog(
      [{ ticket: "TARS-1465", outcome: "landed", pr: "https://github.com/org/repo/pull/431" }],
      async (runsLogPath) => {
        const plan = await planRemoteClose("TARS-1465", runsLogPath);
        expect(plan).toEqual({ ticketKey: "TARS-1465", prUrl: "https://github.com/org/repo/pull/431" });
      },
    );
  });

  it("returns prUrl: null when no run for this ticket has a PR", async () => {
    await withRunsLog(
      [{ ticket: "TARS-1465", outcome: "bounced", pr: null, failure_category: "spec_ambiguous" }],
      async (runsLogPath) => {
        const plan = await planRemoteClose("TARS-1465", runsLogPath);
        expect(plan.prUrl).toBeNull();
      },
    );
  });

  it("returns prUrl: null when runs.jsonl doesn't exist", async () => {
    const plan = await planRemoteClose("TARS-1465", "/nonexistent/runs.jsonl");
    expect(plan.prUrl).toBeNull();
  });

  it("research role: a research runs.jsonl (every line has pr: null) yields prUrl: null, so the PR step is skipped", async () => {
    await withRunsLog(
      [
        { ticket: "TARS-1467", skill: "ticket-refine", outcome: "landed", pr: null },
        { ticket: "TARS-1467", skill: "ticket-refine", outcome: "bounced", pr: null },
      ],
      async (runsLogPath) => {
        const plan = await planRemoteClose("TARS-1467", runsLogPath);
        expect(plan).toEqual({ ticketKey: "TARS-1467", prUrl: null });
      },
    );
  });
});

describe("describeRemoteClosePlan", () => {
  it("names both the Jira ticket and the GitHub Issue", () => {
    const text = describeRemoteClosePlan({ ticketKey: "TARS-1467", prUrl: null });
    expect(text).toContain("close Jira ticket TARS-1467");
    expect(text).toContain("close mirror GitHub Issue for TARS-1467");
  });

  it("names the PR when one was found", () => {
    const text = describeRemoteClosePlan({ ticketKey: "TARS-1465", prUrl: "https://github.com/org/repo/pull/431" });
    expect(text).toContain("close PR https://github.com/org/repo/pull/431");
  });

  it("says nothing to close when no PR was found", () => {
    const text = describeRemoteClosePlan({ ticketKey: "TARS-1465", prUrl: null });
    expect(text).toContain("nothing to close");
  });
});

describe("executeRemoteClose", () => {
  it("closes the Jira ticket, posts a comment first, and reports the transition used", async () => {
    const closeTicket = vi.fn(async () => ({ result: "closed" as const, transitionName: "Close" }));
    const addComment = vi.fn(async () => {});
    const jiraClient = makeMockJiraClient({ closeTicket, addComment });
    const githubClient = makeMockGitHubClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: null },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.jira).toBe("closed");
    expect(summary.jiraDetail).toBe("Close");
    expect(addComment).toHaveBeenCalledTimes(1);
    const [ticketKey] = addComment.mock.calls[0];
    expect(ticketKey).toBe("TARS-1465");

    const addCommentOrder = addComment.mock.invocationCallOrder[0];
    const closeTicketOrder = closeTicket.mock.invocationCallOrder[0];
    expect(addCommentOrder).toBeLessThan(closeTicketOrder);
  });

  it("reports jira: already-done without treating it as an error", async () => {
    const jiraClient = makeMockJiraClient({
      closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
    });
    const githubClient = makeMockGitHubClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: null },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.jira).toBe("already-done");
  });

  it("reports jira: no-transition distinctly from a real error -- never silently treated as success", async () => {
    const jiraClient = makeMockJiraClient({
      closeTicket: vi.fn(async () => ({ result: "no-transition" as const })),
    });
    const githubClient = makeMockGitHubClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: null },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.jira).toBe("no-transition");
  });

  it("a jiraClient failure is caught, reported as jira: error, and never blocks the Issue/PR closes", async () => {
    const jiraClient = makeMockJiraClient({
      closeTicket: vi.fn(async () => {
        throw new Error("Jira API down");
      }),
    });
    const closeIssue = vi.fn(async () => {});
    const githubClient = makeMockGitHubClient({ closeIssue });

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: null },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.jira).toBe("error");
    expect(summary.jiraDetail).toContain("Jira API down");
    expect(closeIssue).toHaveBeenCalledTimes(1);
  });

  it("finds and closes the mirror GitHub Issue with reason not_planned", async () => {
    const closeIssue = vi.fn(async () => {});
    const githubClient = makeMockGitHubClient({
      findIssueByJiraKey: vi.fn(async () => ({ number: 430, url: "https://github.com/org/repo/issues/430" })),
      closeIssue,
    });
    const jiraClient = makeMockJiraClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: null },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.issue).toBe("closed");
    expect(closeIssue).toHaveBeenCalledWith(430, "not_planned");
  });

  it("reports issue: not-found when no mirror Issue exists for this ticket -- not an error", async () => {
    const githubClient = makeMockGitHubClient({
      findIssueByJiraKey: vi.fn(async () => null),
    });
    const jiraClient = makeMockJiraClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: null },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.issue).toBe("not-found");
  });

  it("a githubClient failure on the Issue path is caught, reported as issue: error, and never blocks Jira/PR", async () => {
    const githubClient = makeMockGitHubClient({
      findIssueByJiraKey: vi.fn(async () => {
        throw new Error("GitHub API down");
      }),
    });
    const closeTicket = vi.fn(async () => ({ result: "already-done" as const }));
    const jiraClient = makeMockJiraClient({ closeTicket });

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: null },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.issue).toBe("error");
    expect(summary.issueDetail).toContain("GitHub API down");
    expect(closeTicket).toHaveBeenCalledTimes(1);
  });

  it("closes the PR when prUrl is set", async () => {
    const closePr = vi.fn(async () => "closed" as const);
    const githubClient = makeMockGitHubClient({ closePr });
    const jiraClient = makeMockJiraClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: "https://github.com/org/repo/pull/431" },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.pr).toBe("closed");
    expect(closePr).toHaveBeenCalledWith("https://github.com/org/repo/pull/431");
  });

  it("reports pr: no-pr and never calls closePr when prUrl is null", async () => {
    const closePr = vi.fn(async () => "closed" as const);
    const githubClient = makeMockGitHubClient({ closePr });
    const jiraClient = makeMockJiraClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: null },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.pr).toBe("no-pr");
    expect(closePr).not.toHaveBeenCalled();
  });

  it("a closePr failure is caught and reported as pr: error, independent of Jira/Issue outcomes", async () => {
    const githubClient = makeMockGitHubClient({
      closePr: vi.fn(async () => {
        throw new Error("gh: authentication required");
      }),
    });
    const jiraClient = makeMockJiraClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: "https://github.com/org/repo/pull/431" },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.pr).toBe("error");
    expect(summary.prDetail).toContain("authentication required");
  });

  it("a failed addComment never blocks the actual closeTicket call", async () => {
    const closeTicket = vi.fn(async () => ({ result: "already-done" as const }));
    const jiraClient = makeMockJiraClient({
      addComment: vi.fn(async () => {
        throw new Error("comment post failed");
      }),
      closeTicket,
    });
    const githubClient = makeMockGitHubClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1465", prUrl: null },
      { jiraClient, githubClient, runsLogPath: "" },
    );

    expect(summary.jira).toBe("already-done");
    expect(closeTicket).toHaveBeenCalledTimes(1);
  });
});

describe("describeRemoteCloseSummary", () => {
  it("renders a fully successful close", () => {
    const text = describeRemoteCloseSummary({
      ticketKey: "TARS-1465",
      jira: "closed",
      jiraDetail: "Close",
      issue: "closed",
      pr: "closed",
    });
    expect(text).toContain('closed (via "Close")');
    expect(text).toContain("Issue: closed");
    expect(text).toContain("PR: closed");
  });

  it("distinguishes a no-transition failure from a generic error", () => {
    const text = describeRemoteCloseSummary({
      ticketKey: "TARS-1465",
      jira: "no-transition",
      issue: "not-found",
      pr: "no-pr",
    });
    expect(text).toContain("no done-category transition available");
    expect(text).toContain("none found for this ticket");
    expect(text).toContain("no open PR found locally");
  });

  it("surfaces error detail text for a failed item", () => {
    const text = describeRemoteCloseSummary({
      ticketKey: "TARS-1465",
      jira: "error",
      jiraDetail: "Jira API down",
      issue: "closed",
      pr: "no-pr",
    });
    expect(text).toContain("FAILED -- Jira API down");
  });
});
