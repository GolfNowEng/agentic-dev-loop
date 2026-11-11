// reset-project's --close-remote capability: closing the real Jira
// ticket, its mirror GitHub Issue, and any open PR for a ticket being
// torn down after a diagnostic/test run. Deliberately a separate module
// from reset-project.ts (which stays local-filesystem-only, no network,
// no injected clients) -- keeps the already-tested local-reset logic and
// its temp-filesystem test setup completely untouched by this module's
// very different test shape (injected mock JiraClient/GitHubClient, no
// filesystem beyond a single runs.jsonl read for the PR-URL lookup).
//
// Every remote item (Jira, Issue, PR) is closed independently, wrapped in
// its own try/catch -- one failing must never stop the others, same
// error-isolation stance reconcile.ts already takes per-ticket.

import type { JiraClient } from "./jira-client.ts";
import type { GitHubClient } from "./github-client.ts";
import { findOpenPrUrl } from "../roles/dev/reconcile.ts";

export interface RemoteClosePlan {
  ticketKey: string;
  /** From findOpenPrUrl -- null means no open PR was found locally, so the PR step is skipped entirely. */
  prUrl: string | null;
}

export interface RemoteCloseDeps {
  jiraClient: JiraClient;
  githubClient: GitHubClient;
  /** Read once, before local reset archives/trims it -- see reset-cli.ts's ordering. */
  runsLogPath: string;
}

export interface RemoteCloseSummary {
  ticketKey: string;
  jira: "closed" | "already-done" | "no-transition" | "error";
  /** The transition name actually used (on "closed"), or the caught error's message (on "error"). */
  jiraDetail?: string;
  issue: "closed" | "already-closed" | "not-found" | "error";
  issueDetail?: string;
  pr: "closed" | "already-closed" | "no-pr" | "error";
  prDetail?: string;
}

/**
 * Compute what a remote close would do: recover the ticket's open PR URL
 * (if any) from local run history. Read-only -- no network calls, no
 * writes. Called before executeReset so the PR-URL lookup sees runs.jsonl
 * before local reset archives/trims it.
 */
export async function planRemoteClose(
  ticketKey: string,
  runsLogPath: string,
): Promise<RemoteClosePlan> {
  const prUrl = await findOpenPrUrl(runsLogPath, ticketKey);
  return { ticketKey, prUrl };
}

/**
 * Human-readable preview of a RemoteClosePlan, for --dry-run and for
 * printing before a real run executes it.
 */
export function describeRemoteClosePlan(plan: RemoteClosePlan): string {
  const lines = [
    `- close Jira ticket ${plan.ticketKey} (first available done-category transition)`,
    `- close mirror GitHub Issue for ${plan.ticketKey}`,
    plan.prUrl
      ? `- close PR ${plan.prUrl}`
      : "- no open PR found locally for this ticket -- nothing to close",
  ];
  return lines.join("\n");
}

/**
 * Post one comment on the Jira ticket, before closing it, noting this was
 * a test/reset ticket being closed as not-planned -- so the closed ticket
 * still carries a visible reason, matching the spirit of the manual
 * close-out comment posted on TARS-1465 earlier this session. Never
 * throws on its own failure -- a failed comment must not block the
 * actual close attempt, the same "post first, but don't let a comment
 * failure block the more important write" stance loop-runner.ts's own
 * bounce path already takes for addComment before transitionStatus.
 */
async function postCloseComment(jiraClient: JiraClient, ticketKey: string): Promise<void> {
  const bodyAdf = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Closing via reset-project --close-remote: ",
            marks: [{ type: "strong" }],
          },
          {
            type: "text",
            text: "this was a test/reset ticket, not real finished work -- closed as not planned.",
          },
        ],
      },
    ],
  };
  try {
    await jiraClient.addComment(ticketKey, bodyAdf);
  } catch {
    // Swallowed deliberately -- see doc comment above.
  }
}

/**
 * Execute a RemoteClosePlan for real: close the Jira ticket, its mirror
 * GitHub Issue, and (if one was found) its open PR. Each of the three is
 * independent -- a failure on one is recorded as "error" in the summary
 * and never prevents the other two from being attempted.
 */
export async function executeRemoteClose(
  plan: RemoteClosePlan,
  deps: RemoteCloseDeps,
): Promise<RemoteCloseSummary> {
  const { jiraClient, githubClient } = deps;
  const summary: RemoteCloseSummary = {
    ticketKey: plan.ticketKey,
    jira: "error",
    issue: "error",
    pr: plan.prUrl ? "error" : "no-pr",
  };

  try {
    await postCloseComment(jiraClient, plan.ticketKey);
    const result = await jiraClient.closeTicket(plan.ticketKey);
    summary.jira = result.result;
    if (result.result === "closed") {
      summary.jiraDetail = result.transitionName;
    }
  } catch (err) {
    summary.jira = "error";
    summary.jiraDetail = err instanceof Error ? err.message : String(err);
  }

  try {
    const issue = await githubClient.findIssueByJiraKey(plan.ticketKey);
    if (!issue) {
      summary.issue = "not-found";
    } else {
      await githubClient.closeIssue(issue.number, "not_planned");
      summary.issue = "closed";
    }
  } catch (err) {
    summary.issue = "error";
    summary.issueDetail = err instanceof Error ? err.message : String(err);
  }

  if (plan.prUrl) {
    try {
      const prResult = await githubClient.closePr(plan.prUrl);
      summary.pr = prResult;
    } catch (err) {
      summary.pr = "error";
      summary.prDetail = err instanceof Error ? err.message : String(err);
    }
  }

  return summary;
}

/** Human-readable rendering of a RemoteCloseSummary, one line per item, printed after a real run. */
export function describeRemoteCloseSummary(summary: RemoteCloseSummary): string {
  const jiraLine =
    summary.jira === "closed"
      ? `- Jira ${summary.ticketKey}: closed (via "${summary.jiraDetail}")`
      : summary.jira === "already-done"
        ? `- Jira ${summary.ticketKey}: already done, no-op`
        : summary.jira === "no-transition"
          ? `- Jira ${summary.ticketKey}: FAILED -- no done-category transition available from its current status (may need an intermediate status first)`
          : `- Jira ${summary.ticketKey}: FAILED -- ${summary.jiraDetail}`;

  const issueLine =
    summary.issue === "closed"
      ? "- GitHub Issue: closed (not planned)"
      : summary.issue === "already-closed"
        ? "- GitHub Issue: already closed, no-op"
        : summary.issue === "not-found"
          ? "- GitHub Issue: none found for this ticket -- nothing to close"
          : `- GitHub Issue: FAILED -- ${summary.issueDetail}`;

  const prLine =
    summary.pr === "closed"
      ? "- PR: closed"
      : summary.pr === "already-closed"
        ? "- PR: already closed/merged, no-op"
        : summary.pr === "no-pr"
          ? "- PR: no open PR found locally -- nothing to close"
          : `- PR: FAILED -- ${summary.prDetail}`;

  return [jiraLine, issueLine, prLine].join("\n");
}
