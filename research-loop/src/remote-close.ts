// reset-project's --close-remote capability: closing the real Jira
// ticket and its mirror GitHub Issue for a ticket being torn down after
// a diagnostic/test run. Deliberately a separate module from
// reset-project.ts (which stays local-filesystem-only, no network, no
// injected clients) -- keeps the already-tested local-reset logic and
// its temp-filesystem test setup completely untouched by this module's
// very different test shape (injected mock JiraClient/GitHubClient, no
// filesystem at all).
//
// Unlike dev-loop's identical module, there is no PR to close here --
// this repo never opens a PR (that's dev-loop's job, downstream of the
// pipeline:research -> pipeline:dev handoff); RunLogLine here carries no
// `pr` field at all, and there is no reconcile.ts to mirror a
// findOpenPrUrl-equivalent lookup from.
//
// Each of the Jira ticket and the GitHub Issue is closed independently,
// wrapped in its own try/catch -- one failing must never stop the other.

import type { JiraClient } from "./jira-client.ts";
import type { GitHubClient } from "./github-client.ts";

export interface RemoteClosePlan {
  ticketKey: string;
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
}

/**
 * Trivial today (no local data to read for this repo -- see the
 * top-of-file comment), but kept as its own function for symmetry with
 * dev-loop's identical module and reset-cli.ts's shared calling
 * convention (plan first, print, then execute).
 */
export function planRemoteClose(ticketKey: string): RemoteClosePlan {
  return { ticketKey };
}

/**
 * Human-readable preview of a RemoteClosePlan, for --dry-run and for
 * printing before a real run executes it.
 */
export function describeRemoteClosePlan(plan: RemoteClosePlan): string {
  return [
    `- close Jira ticket ${plan.ticketKey} (first available done-category transition)`,
    `- close mirror GitHub Issue for ${plan.ticketKey}`,
  ].join("\n");
}

/**
 * Post one comment on the Jira ticket, before closing it, noting this was
 * a test/reset ticket being closed as not-planned -- so the closed ticket
 * still carries a visible reason, matching the spirit of the manual
 * close-out comment posted on TARS-1465 earlier this session. Never
 * throws on its own failure -- a failed comment must not block the
 * actual close attempt.
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
 * Execute a RemoteClosePlan for real: close the Jira ticket and its
 * mirror GitHub Issue. Each is independent -- a failure on one is
 * recorded as "error" in the summary and never prevents the other from
 * being attempted.
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

  return [jiraLine, issueLine].join("\n");
}
