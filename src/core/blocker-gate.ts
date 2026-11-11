/**
 * The blocker gate (spec §6.3.2): a ticket with Jira "is blocked by" links
 * is only worked once every blocker is cleared. This file is the single
 * rule -- change isBlockerCleared to change it.
 *
 * A blocker is cleared iff its work merged into the default branch of this
 * project's own `github.repo`:
 *   - the PR recorded for it in the landed logs (findLandedPrUrl) has a
 *     `mergedAt`, or
 *   - a gh search finds a merged PR into `defaultBranch` whose head branch
 *     or title carries the blocker key as a whole token (so a recorded PR
 *     closed unmerged, with the real one merged, still counts).
 * Everything else is not cleared, including every thrown error (fail
 * closed). A blocker from a different Jira project is not looked up at all:
 * it can't have a PR in this repo, so it gets the "needs a human" reason
 * straight away. A human clears such a blocker by removing the link; the
 * ticket is picked up on the next poll.
 */

import type { JiraClient } from "./jira-client.ts";
import type { ExecGhFindMergedPrFn, ExecGhPrViewFn } from "./github-client.ts";
import { redactSensitive } from "./redact.ts";

/** Cap on the gh/Jira error text kept in a reason (reasons end up in logs). */
const MAX_ERROR_CHARS = 200;

export interface BlockerGateDeps {
  /** The project's own `github.repo` (owner/name); only used in reasons, lookups are bound to it by the caller. */
  repo: string;
  /** Latest landed dev PR URL for a ticket key, or null (findLandedPrUrlAcross with the slug bound). */
  findLandedPrUrl: (key: string) => Promise<string | null>;
  execGhPrView: ExecGhPrViewFn;
  execGhFindMergedPr: ExecGhFindMergedPrFn;
  defaultBranch: string;
  /** blockerKey -> merged PR URL. Process-lifetime, caller-owned. Only cleared results go in (merged never reverts). */
  mergedCache: Map<string, string>;
  /**
   * The gated ticket's Jira project key (the part before "-"). A blocker
   * from any other project is not cleared without calling gh. gateTicket
   * fills this in from the ticket key.
   */
  projectKey?: string;
}

export interface BlockerCheck {
  cleared: boolean;
  reason: string;
}

export type GateResult = { pass: true } | { pass: false; blockedBy: string[]; reasons: string[] };

function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactSensitive(message).slice(0, MAX_ERROR_CHARS);
}

const needsHuman = (key: string, repo: string): string =>
  `blocker ${key} has no merged PR in ${repo} — needs a human (Done without a PR, or another repo)`;

export async function isBlockerCleared(blockerKey: string, deps: BlockerGateDeps): Promise<BlockerCheck> {
  const cached = deps.mergedCache.get(blockerKey);
  if (cached) return { cleared: true, reason: `blocker ${blockerKey} merged: ${cached}` };

  if (deps.projectKey !== undefined && projectOf(blockerKey) !== deps.projectKey) {
    return { cleared: false, reason: needsHuman(blockerKey, deps.repo) };
  }

  const cleared = (url: string): BlockerCheck => {
    deps.mergedCache.set(blockerKey, url);
    return { cleared: true, reason: `blocker ${blockerKey} merged: ${url}` };
  };

  try {
    let openPr: string | null = null;
    const recorded = await deps.findLandedPrUrl(blockerKey);
    if (recorded) {
      const status = JSON.parse(await deps.execGhPrView(recorded)) as { state?: string; mergedAt?: string | null };
      if (status.mergedAt) return cleared(recorded);
      if (status.state === "OPEN") openPr = recorded;
    }

    const found = await deps.execGhFindMergedPr(blockerKey, { baseRefName: deps.defaultBranch });
    // Re-check the base here too, so the rule holds whatever finder is injected.
    if (found && found.mergedAt && found.baseRefName === deps.defaultBranch) return cleared(found.url);

    if (openPr) return { cleared: false, reason: `blocker ${blockerKey} PR open: ${openPr}` };
    return { cleared: false, reason: needsHuman(blockerKey, deps.repo) };
  } catch (err) {
    return { cleared: false, reason: `blocker ${blockerKey} check failed: ${errorText(err)}` };
  }
}

/**
 * Pass only when every "is blocked by" link is cleared. A failure reading
 * the links themselves fails closed too (pass: false, no blockedBy).
 */
export async function gateTicket(
  ticketKey: string,
  deps: BlockerGateDeps & { jira: JiraClient },
): Promise<GateResult> {
  let blockers: string[];
  try {
    blockers = await deps.jira.getBlockedBy(ticketKey);
  } catch (err) {
    return { pass: false, blockedBy: [], reasons: [`blockers of ${ticketKey} check failed: ${errorText(err)}`] };
  }

  const checkDeps: BlockerGateDeps = { ...deps, projectKey: projectOf(ticketKey) };
  const blockedBy: string[] = [];
  const reasons: string[] = [];
  for (const key of blockers) {
    const r = await isBlockerCleared(key, checkDeps);
    if (!r.cleared) {
      blockedBy.push(key);
      reasons.push(r.reason);
    }
  }
  return blockedBy.length === 0 ? { pass: true } : { pass: false, blockedBy, reasons };
}
