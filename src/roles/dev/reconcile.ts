/**
 * dev-loop's per-poll merge-reconciliation pass. Nothing in this pipeline
 * reacts to a GitHub PR merge event, and a merge routinely happens while
 * dev-loop is off, after which Jira's own merge automation moves the ticket
 * out of Code Review (e.g. to Development Complete). So this pass does not
 * look at Jira status at all: it works from runs.jsonl, taking every ticket
 * whose latest "landed" line is inside a recent window, and asks GitHub
 * (`gh pr view --json state,mergedAt`) whether that PR merged. For each
 * merged one it comments on and closes the mirror GitHub Issue (state_reason
 * "completed", skipped if already closed) and removes the handoff label
 * (pipeline:dev) from the Jira ticket, leaving only the repo label. That is
 * the only Jira write this pass makes: it never changes status or assignee,
 * and a failed label removal is swallowed (runLoopIteration's landed-ticket
 * guard is the backstop). Called once per iteration from main.ts's poll
 * loop, before runLoopIteration.
 */

import type { JiraClient } from "../../core/jira-client.ts";
import type { GitHubClient, ExecGhPrViewFn, ExecGhFindMergedPrFn } from "../../core/github-client.ts";
import type { DevView } from "../../core/types.ts";
import { readRunLog } from "../../core/runs-log.ts";

/** How far back a "landed" line still counts as a candidate. */
const LANDED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReconcileDeps {
  jiraClient: JiraClient;
  githubClient: GitHubClient;
  /** The dev role's settings; its triggerLabel is the stage label removed on merge. */
  view: DevView;
  runsLogPath: string;
  execGhPrView: ExecGhPrViewFn;
  /**
   * Fallback for when the recorded PR was closed unmerged but the work landed
   * under a different PR (e.g. TARS-1487: #470 closed, #476 merged). Optional.
   */
  execGhFindMergedPr?: ExecGhFindMergedPrFn;
  /** Injected clock for the landed window; defaults to the real one. */
  now?: Date;
  /**
   * Ticket keys already fully reconciled by this process. Pass the same Set
   * on every call so a merged ticket is not re-checked each poll cycle.
   */
  reconciled?: Set<string>;
}

export interface ReconcileResult {
  /** How many landed tickets this pass examined. */
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

/** A ticket's most recent "landed" run: its PR and when the run ended. */
export interface LandedTicket {
  ticket: string;
  pr: string;
  ended: string;
}

/** Latest "landed" line with a PR per ticket key, in runs.jsonl order of first appearance. Missing/unreadable log -> []. */
export async function findLandedTickets(runsLogPath: string): Promise<LandedTicket[]> {
  let lines;
  try {
    lines = await readRunLog(runsLogPath);
  } catch {
    return [];
  }
  const latest = new Map<string, LandedTicket>();
  for (const l of lines) {
    if (l.outcome === "landed" && l.pr) {
      latest.set(l.ticket, { ticket: l.ticket, pr: l.pr, ended: l.ended });
    }
  }
  return [...latest.values()];
}

/** PR URL of the ticket's latest "landed" run, or null if it never landed. */
export async function findLandedPrUrl(runsLogPath: string, ticketKey: string): Promise<string | null> {
  const found = (await findLandedTickets(runsLogPath)).find((t) => t.ticket === ticketKey);
  return found?.pr ?? null;
}

/**
 * Build the comment left on a mirror Issue when reconcile closes it, so a
 * closed Issue never looks like it was closed by a human with no context.
 * Kept to a fixed short template. mergedAt is rendered as "YYYY-MM-DD HH:MM UTC".
 */
export function buildCloseComment(info: { prUrl: string; mergedAt: string; ticketKey: string }): string {
  const merged = new Date(info.mergedAt).toISOString().slice(0, 16).replace("T", " ");
  return [
    "**Closed automatically by dev-loop**",
    "",
    `PR: ${info.prUrl}`,
    `Merged: ${merged} UTC`,
    `Ticket: ${info.ticketKey}`,
    "Reason: PR merged, closed as completed",
  ].join("\n");
}

/**
 * Post the close comment before closing. Never throws -- a failed comment
 * must not block the close itself, same stance as remote-close.ts's
 * postCloseComment for the Jira side.
 */
async function postCloseComment(
  githubClient: GitHubClient,
  issueNumber: number,
  info: { prUrl: string; mergedAt: string; ticketKey: string },
): Promise<void> {
  try {
    await githubClient.addComment(issueNumber, buildCloseComment(info));
  } catch {
    // Swallowed deliberately -- see doc comment above.
  }
}

export async function reconcileMergedTickets(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { jiraClient, githubClient, view, runsLogPath, execGhPrView } = deps;
  const now = deps.now ?? new Date();
  const reconciled = deps.reconciled;

  const candidates = (await findLandedTickets(runsLogPath)).filter(
    (t) =>
      !reconciled?.has(t.ticket) &&
      now.getTime() - new Date(t.ended).getTime() <= LANDED_WINDOW_MS,
  );

  const result: ReconcileResult = { checked: candidates.length, closed: [], errors: [] };

  for (const { ticket, pr: prUrl } of candidates) {
    try {
      const raw = await execGhPrView(prUrl);
      const prStatus = JSON.parse(raw) as GhPrViewResult;

      let mergedPrUrl = prUrl;
      let mergedAt = prStatus.mergedAt;
      if (!mergedAt && prStatus.state === "CLOSED" && deps.execGhFindMergedPr) {
        const other = await deps.execGhFindMergedPr(ticket);
        if (other) {
          mergedPrUrl = other.url;
          mergedAt = other.mergedAt;
        }
      }
      if (!mergedAt) {
        continue;
      }

      const issue = await githubClient.findIssueByJiraKey(ticket);
      if (issue && issue.state !== "CLOSED") {
        await postCloseComment(githubClient, issue.number, {
          prUrl: mergedPrUrl,
          mergedAt,
          ticketKey: ticket,
        });
        await githubClient.closeIssue(issue.number, "completed");
      }

      // Never blocks or fails the reconcile: the landed-ticket guard in
      // runLoopIteration keeps a ticket that still carries the label from
      // being re-run.
      try {
        await jiraClient.removeLabel(ticket, view.triggerLabel);
      } catch {
        // Swallowed deliberately -- see above.
      }

      reconciled?.add(ticket);
      result.closed.push(ticket);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ ticket, message });
    }
  }

  return result;
}
