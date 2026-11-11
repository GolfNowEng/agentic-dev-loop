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
import type { GitHubClient } from "../../core/github-client.ts";
import type { Config } from "../../core/types.ts";
import { readRunLog } from "../../core/runs-log.ts";

/** Stand-in for `gh pr view <url> --json state,mergedAt`, returning its raw JSON stdout. Injected so tests never shell out for real. */
export type ExecGhPrViewFn = (prUrl: string) => Promise<string>;

/** Find a merged PR in the target repo that carries this ticket's work (matched by ticket key in head branch or title), or null. */
export type ExecGhFindMergedPrFn = (ticketKey: string) => Promise<{ url: string; mergedAt: string } | null>;

/** How far back a "landed" line still counts as a candidate. */
const LANDED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReconcileDeps {
  jiraClient: JiraClient;
  githubClient: GitHubClient;
  config: Config;
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
  const { jiraClient, githubClient, config, runsLogPath, execGhPrView } = deps;
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
        await jiraClient.removeLabel(ticket, config.jira.handoffLabel);
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

/**
 * Real ExecGhFindMergedPrFn: lists merged PRs in `repo` mentioning the ticket
 * key, keeping only those whose head branch or title contains it as a whole
 * token (so TARS-148 never matches TARS-1487). Latest merge wins.
 */
export function realExecGhFindMergedPr(repo: string): ExecGhFindMergedPrFn {
  return async (ticketKey: string) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("gh", [
      "pr", "list", "-R", repo, "--state", "merged", "--search", ticketKey,
      "--json", "url,mergedAt,title,headRefName", "--limit", "20",
    ]);
    const token = new RegExp(`(^|[^A-Za-z0-9])${ticketKey}($|[^0-9])`);
    const prs = (JSON.parse(stdout) as Array<{ url: string; mergedAt: string; title: string; headRefName: string }>)
      .filter((p) => p.mergedAt && (token.test(p.headRefName) || token.test(p.title)))
      .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    return prs[0] ? { url: prs[0].url, mergedAt: prs[0].mergedAt } : null;
  };
}
