import { describe, expect, it, vi } from "vitest";
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
    claim: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => {}),
    swapLabel: vi.fn(async () => {}),
    assignTicket: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
    ...overrides,
  };
}

function makeMockGitHubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "https://github.com/org/repo/issues/42" })),
    createIssue: vi.fn(async () => ({ number: 42, url: "https://github.com/org/repo/issues/42" })),
    closeIssue: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("planRemoteClose", () => {
  it("returns a plan naming the ticket key", () => {
    const plan = planRemoteClose("TARS-1467");
    expect(plan).toEqual({ ticketKey: "TARS-1467" });
  });
});

describe("describeRemoteClosePlan", () => {
  it("names both the Jira ticket and the GitHub Issue", () => {
    const text = describeRemoteClosePlan({ ticketKey: "TARS-1467" });
    expect(text).toContain("close Jira ticket TARS-1467");
    expect(text).toContain("close mirror GitHub Issue for TARS-1467");
  });
});

describe("executeRemoteClose", () => {
  it("closes the Jira ticket, posts a comment first, and reports the transition used", async () => {
    const closeTicket = vi.fn(async () => ({ result: "closed" as const, transitionName: "Close" }));
    const addComment = vi.fn(async () => {});
    const jiraClient = makeMockJiraClient({ closeTicket, addComment });
    const githubClient = makeMockGitHubClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1467" },
      { jiraClient, githubClient },
    );

    expect(summary.jira).toBe("closed");
    expect(summary.jiraDetail).toBe("Close");
    expect(addComment).toHaveBeenCalledTimes(1);

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
      { ticketKey: "TARS-1467" },
      { jiraClient, githubClient },
    );

    expect(summary.jira).toBe("already-done");
  });

  it("reports jira: no-transition distinctly from a real error", async () => {
    const jiraClient = makeMockJiraClient({
      closeTicket: vi.fn(async () => ({ result: "no-transition" as const })),
    });
    const githubClient = makeMockGitHubClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1467" },
      { jiraClient, githubClient },
    );

    expect(summary.jira).toBe("no-transition");
  });

  it("a jiraClient failure is caught, reported as jira: error, and never blocks the Issue close", async () => {
    const jiraClient = makeMockJiraClient({
      closeTicket: vi.fn(async () => {
        throw new Error("Jira API down");
      }),
    });
    const closeIssue = vi.fn(async () => {});
    const githubClient = makeMockGitHubClient({ closeIssue });

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1467" },
      { jiraClient, githubClient },
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
      { ticketKey: "TARS-1467" },
      { jiraClient, githubClient },
    );

    expect(summary.issue).toBe("closed");
    expect(closeIssue).toHaveBeenCalledWith(430, "not_planned");
  });

  it("reports issue: not-found when no mirror Issue exists -- not an error", async () => {
    const githubClient = makeMockGitHubClient({
      findIssueByJiraKey: vi.fn(async () => null),
    });
    const jiraClient = makeMockJiraClient();

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1467" },
      { jiraClient, githubClient },
    );

    expect(summary.issue).toBe("not-found");
  });

  it("a githubClient failure is caught, reported as issue: error, and never blocks Jira", async () => {
    const githubClient = makeMockGitHubClient({
      findIssueByJiraKey: vi.fn(async () => {
        throw new Error("GitHub API down");
      }),
    });
    const closeTicket = vi.fn(async () => ({ result: "already-done" as const }));
    const jiraClient = makeMockJiraClient({ closeTicket });

    const summary = await executeRemoteClose(
      { ticketKey: "TARS-1467" },
      { jiraClient, githubClient },
    );

    expect(summary.issue).toBe("error");
    expect(summary.issueDetail).toContain("GitHub API down");
    expect(closeTicket).toHaveBeenCalledTimes(1);
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
      { ticketKey: "TARS-1467" },
      { jiraClient, githubClient },
    );

    expect(summary.jira).toBe("already-done");
    expect(closeTicket).toHaveBeenCalledTimes(1);
  });
});

describe("describeRemoteCloseSummary", () => {
  it("renders a fully successful close", () => {
    const text = describeRemoteCloseSummary({
      ticketKey: "TARS-1467",
      jira: "closed",
      jiraDetail: "Close",
      issue: "closed",
    });
    expect(text).toContain('closed (via "Close")');
    expect(text).toContain("Issue: closed");
  });

  it("distinguishes a no-transition failure from a generic error", () => {
    const text = describeRemoteCloseSummary({
      ticketKey: "TARS-1467",
      jira: "no-transition",
      issue: "not-found",
    });
    expect(text).toContain("no done-category transition available");
    expect(text).toContain("none found for this ticket");
  });

  it("surfaces error detail text for a failed item", () => {
    const text = describeRemoteCloseSummary({
      ticketKey: "TARS-1467",
      jira: "error",
      jiraDetail: "Jira API down",
      issue: "closed",
    });
    expect(text).toContain("FAILED -- Jira API down");
  });
});
