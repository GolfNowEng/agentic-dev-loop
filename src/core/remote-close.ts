// reset-project's --close-remote capability: closing the real Jira
// ticket, its mirror GitHub Issue, and any open PR for a ticket being
// torn down after a diagnostic/test run. Deliberately a separate module
// from reset-project.ts (which stays local-filesystem-only, no network,
// no injected clients) -- keeps the already-tested local-reset logic and
// its temp-filesystem test setup completely untouched by this module's
// very different test shape (injected mock JiraClient/GitHubClient, no
// filesystem at all).
//
// Every remote item (Jira, Issue, PR) is closed independently, wrapped in
// its own try/catch -- one failing must never stop the others, same
// error-isolation stance roles/dev/reconcile.ts already takes per-ticket.
//
// Shared by both roles. The PR step runs only when the plan carries a PR
// URL, which reset-cli.ts looks up with findRecordedPrUrlAcross
// (core/iteration-log.ts, v1 and v2 logs) before local reset archives
// anything. Research never opens a PR, so a research-only ticket has no
// URL and the step reports "no-pr" without calling GitHub.

import type { JiraClient } from "./jira-client.ts";
import type { GitHubClient } from "./github-client.ts";

export interface RemoteClosePlan {
  ticketKey: string;
  /** From findRecordedPrUrlAcross -- null means no PR was found locally, so the PR step is skipped entirely. */
  prUrl: string | null;
}

export interface RemoteCloseDeps {
  jiraClient: JiraClient;
  githubClient: GitHubClient;
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

/** Close the Jira ticket (comment first, then the first done-category transition). Throws on a request error. */
export async function closeJiraTicket(
  jiraClient: JiraClient,
  ticketKey: string,
): Promise<Pick<RemoteCloseSummary, "jira" | "jiraDetail">> {
  await postCloseComment(jiraClient, ticketKey);
  const result = await jiraClient.closeTicket(ticketKey);
  return result.result === "closed" ? { jira: "closed", jiraDetail: result.transitionName } : { jira: result.result };
}

/** Close the ticket's mirror GitHub Issue as not planned. Throws on a request error. */
export async function closeMirrorIssue(githubClient: GitHubClient, ticketKey: string): Promise<"closed" | "not-found"> {
  const issue = await githubClient.findIssueByJiraKey(ticketKey);
  if (!issue) return "not-found";
  await githubClient.closeIssue(issue.number, "not_planned");
  return "closed";
}

/** Close the recorded PR. Throws on a request error. */
export async function closeRecordedPr(githubClient: GitHubClient, prUrl: string): Promise<"closed" | "already-closed"> {
  return githubClient.closePr(prUrl);
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
    Object.assign(summary, await closeJiraTicket(jiraClient, plan.ticketKey));
  } catch (err) {
    summary.jira = "error";
    summary.jiraDetail = errorMessage(err);
  }

  try {
    summary.issue = await closeMirrorIssue(githubClient, plan.ticketKey);
  } catch (err) {
    summary.issue = "error";
    summary.issueDetail = errorMessage(err);
  }

  if (plan.prUrl) {
    try {
      summary.pr = await closeRecordedPr(githubClient, plan.prUrl);
    } catch (err) {
      summary.pr = "error";
      summary.prDetail = errorMessage(err);
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
