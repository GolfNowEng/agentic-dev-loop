/**
 * dev-loop's per-poll merge-reconciliation pass. Nothing in this pipeline
 * reacts to a GitHub PR merge event, and a merge routinely happens while
 * dev-loop is off, after which Jira's own merge automation moves the ticket
 * out of Code Review (e.g. to Development Complete). So this pass does not
 * look at Jira status at all: it works from the landed logs of both
 * generations (findLandedTicketsAcross: the v2 log, and the v1 dev log in
 * either layout, v2 winning per ticket), taking every ticket whose latest
 * landed run is inside a recent window, and asks GitHub
 * (`gh pr view --json state,mergedAt`) whether that PR merged. For each
 * merged one it comments on and closes the mirror GitHub Issue (state_reason
 * "completed", skipped if already closed; the comment ends with
 * `— <session>`) and removes every pipeline label from the Jira ticket (the
 * research trigger, the handoff, the dev trigger, and the v1
 * pipeline:research / pipeline:dev), leaving only the repo label. That is
 * the only Jira write this pass makes: it never changes status or assignee,
 * and a failed label removal is swallowed (the worker cycle's dev landed
 * guard, src/worker/cycle-steps.ts, is the backstop). Called once per
 * iteration from main.ts's `--phase dev` loop, before runWorkerIteration.
 */

import type { JiraClient } from "../../core/jira-client.ts";
import type { GitHubClient, ExecGhPrViewFn, ExecGhFindMergedPrFn } from "../../core/github-client.ts";
import type { Config } from "../../core/types.ts";
import { roleView } from "../../core/config.ts";
import { findLandedTicketsAcross } from "../../core/iteration-log.ts";
import { withSessionSuffixText } from "./code-review.ts";

/** How far back a "landed" line still counts as a candidate. */
const LANDED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReconcileDeps {
  jiraClient: JiraClient;
  githubClient: GitHubClient;
  /** The project config: its role labels are the ones removed on merge. */
  config: Config;
  /** The v2 project slug: which runs/v2/<slug>.jsonl and v1 dev log are read. */
  slug: string;
  /** The worker session name, appended to the close comment. */
  session: string;
  /** State root override for tests; defaults to the repo root. */
  root?: string;
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

/** The v1 role labels, removed too so a ticket labelled before the cutover ends up clean. */
const V1_PIPELINE_LABELS = ["pipeline:research", "pipeline:dev"];

/** Every pipeline label reconcile strips from a merged ticket, de-duplicated. */
export function pipelineLabels(config: Config): string[] {
  const research = roleView(config, "research");
  const dev = roleView(config, "dev");
  return [...new Set([research.triggerLabel, research.handoffLabel, dev.triggerLabel, ...V1_PIPELINE_LABELS])];
}

/**
 * Build the comment left on a mirror Issue when reconcile closes it, so a
 * closed Issue never looks like it was closed by a human with no context.
 * Kept to a fixed short template. mergedAt is rendered as "YYYY-MM-DD HH:MM UTC".
 */
export function buildCloseComment(info: { prUrl: string; mergedAt: string; ticketKey: string; session: string }): string {
  const merged = new Date(info.mergedAt).toISOString().slice(0, 16).replace("T", " ");
  return withSessionSuffixText([
    "**Closed automatically by dev-loop**",
    "",
    `PR: ${info.prUrl}`,
    `Merged: ${merged} UTC`,
    `Ticket: ${info.ticketKey}`,
    "Reason: PR merged, closed as completed",
  ].join("\n"), info.session);
}

/**
 * Post the close comment before closing. Never throws -- a failed comment
 * must not block the close itself, same stance as remote-close.ts's
 * postCloseComment for the Jira side.
 */
async function postCloseComment(
  githubClient: GitHubClient,
  issueNumber: number,
  info: { prUrl: string; mergedAt: string; ticketKey: string; session: string },
): Promise<void> {
  try {
    await githubClient.addComment(issueNumber, buildCloseComment(info));
  } catch {
    // Swallowed deliberately -- see doc comment above.
  }
}

export async function reconcileMergedTickets(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { jiraClient, githubClient, execGhPrView } = deps;
  const now = deps.now ?? new Date();
  const reconciled = deps.reconciled;

  const candidates = (await findLandedTicketsAcross(deps.slug, deps.root)).filter(
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
          session: deps.session,
        });
        await githubClient.closeIssue(issue.number, "completed");
      }

      // Never blocks or fails the reconcile: the worker cycle's dev landed
      // guard keeps a ticket that still carries the label from being re-run.
      // removeLabel is a no-op for a label the ticket doesn't carry.
      for (const label of pipelineLabels(deps.config)) {
        try {
          await jiraClient.removeLabel(ticket, label);
        } catch {
          // Swallowed deliberately -- see above.
        }
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
