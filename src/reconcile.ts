/**
 * dev-loop's startup-time merge-reconciliation pass. Per
 * docs/future-enhancements.md's Jira label-based trigger design: nothing
 * in this pipeline reacts to a GitHub PR merge event -- GitHub's own
 * "Closes #N" convention auto-closes the mirror Issue on a merge that
 * happens while dev-loop is running, but a merge that happens while
 * dev-loop is offline (or a PR that predates that convention being used)
 * can't assume the auto-close already ran. This pass finds every ticket
 * currently sitting at Code Review (handoffLabel + statusNames.prOpen),
 * resolves each one's PR URL from its own runs.jsonl history (the most
 * recent "landed" line for that ticket key -- no new field needed,
 * RunLogLine.pr already carries it), checks the real merge state via
 * `gh pr view --json state,mergedAt`, and for any that merged, closes the
 * mirror GitHub Issue (state_reason "completed"). Deliberately does NOT
 * touch the Jira ticket's own status/label -- a human closes the Jira
 * ticket by hand; this pass only keeps the GitHub Issue from going stale.
 * This is a startup-time/per-poll-cycle reconciliation step, not a
 * separately-scheduled job or webhook -- called once per iteration from
 * main.ts's poll loop, before runLoopIteration.
 */

import type { JiraClient } from "./jira-client.ts";
import type { GitHubClient } from "./github-client.ts";
import type { Config } from "./types.ts";
import { readRunLog } from "./runs-log.ts";

/** Stand-in for `gh pr view <url> --json state,mergedAt`, returning its raw JSON stdout. Injected so tests never shell out for real. */
export type ExecGhPrViewFn = (prUrl: string) => Promise<string>;

export interface ReconcileDeps {
  jiraClient: JiraClient;
  githubClient: GitHubClient;
  config: Config;
  runsLogPath: string;
  execGhPrView: ExecGhPrViewFn;
}

export interface ReconcileResult {
  /** How many Code-Review tickets this pass examined. */
  checked: number;
  /** Ticket keys whose PR was confirmed merged and whose mirror Issue was closed this pass (or already closed -- see closeIssue's own idempotency). */
  closed: string[];
  /** Per-ticket failures -- a gh/GitHub call that failed for one ticket never stops the pass from checking the rest. */
  errors: Array<{ ticket: string; message: string }>;
}

interface GhPrViewResult {
  state: string;
  mergedAt: string | null;
}

/**
 * Build the JQL for "tickets at Code Review" -- handoffLabel (the same
 * label pollJql.dev already matches on) plus status = statusNames.prOpen.
 * A separate template from pollJql.dev itself (that one now also excludes
 * bounced-status tickets, which is irrelevant here -- Code Review status
 * is never bounced status).
 */
function buildPrOpenJql(config: Config): string {
  return `labels = "${config.jira.handoffLabel}" AND labels = "${config.jira.repoLabel}" AND status = "${config.jira.statusNames.prOpen}" ORDER BY created ASC`;
}

/** Find the most recent "landed" run for this ticket key in runs.jsonl, or null if none exists. */
async function findLandedPrUrl(runsLogPath: string, ticketKey: string): Promise<string | null> {
  let lines;
  try {
    lines = await readRunLog(runsLogPath);
  } catch {
    return null;
  }
  const landedLines = lines.filter((l) => l.ticket === ticketKey && l.outcome === "landed" && l.pr);
  const last = landedLines[landedLines.length - 1];
  return last?.pr ?? null;
}

export async function reconcileMergedTickets(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { jiraClient, githubClient, config, runsLogPath, execGhPrView } = deps;

  const jql = buildPrOpenJql(config);
  const tickets = await jiraClient.pollAllMatching(jql);

  const result: ReconcileResult = { checked: tickets.length, closed: [], errors: [] };

  for (const ticket of tickets) {
    try {
      const prUrl = await findLandedPrUrl(runsLogPath, ticket.key);
      if (!prUrl) {
        result.errors.push({
          ticket: ticket.key,
          message: `no landed run found in ${runsLogPath} for ${ticket.key} -- cannot determine its PR URL`,
        });
        continue;
      }

      const raw = await execGhPrView(prUrl);
      const prStatus = JSON.parse(raw) as GhPrViewResult;

      if (!prStatus.mergedAt) {
        continue;
      }

      const issue = await githubClient.findIssueByJiraKey(ticket.key);
      if (issue) {
        await githubClient.closeIssue(issue.number, "completed");
      }
      result.closed.push(ticket.key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ ticket: ticket.key, message });
    }
  }

  return result;
}

/**
 * Real ExecGhPrViewFn for production wiring: spawns
 * `gh pr view <url> --json state,mergedAt`, returning stdout.
 */
export function realExecGhPrView(): ExecGhPrViewFn {
  return async (prUrl: string): Promise<string> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync("gh", [
        "pr",
        "view",
        prUrl,
        "--json",
        "state,mergedAt",
      ]);
      return stdout;
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(stderr ? `${message}: ${stderr}` : message);
    }
  };
}
