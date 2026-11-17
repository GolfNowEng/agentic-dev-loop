/**
 * Which GitHub Issue is a research run's mirror. An Issue closed as "not
 * planned" (what reset leaves behind) is never reused: research opens a fresh
 * one that links back, and reads the old one only as prior context.
 */

import type { GitHubIssue } from "../../core/github-client.ts";

export function pickMirrorIssue(issues: GitHubIssue[]): { reuse: GitHubIssue | null; previous: GitHubIssue[] } {
  const newestFirst = [...issues].sort((a, b) => b.number - a.number);
  const notPlanned = (i: GitHubIssue) => i.state === "CLOSED" && i.stateReason === "NOT_PLANNED";
  return {
    reuse: newestFirst.find((i) => !notPlanned(i)) ?? null,
    previous: newestFirst.filter(notPlanned),
  };
}

export function buildMirrorIssueBody(ticketKey: string, baseUrl: string, previous: GitHubIssue[]): string {
  const base = `Mirror of [${ticketKey}](${baseUrl}/browse/${ticketKey}). ticket-refine is running -- this Issue will be updated with recon/attack/verify findings per the routing rule as the run progresses.`;
  return [base, ...(previous.length > 0 ? [""] : []), ...previous.map((i) => `Previous attempt: #${i.number}`)].join("\n");
}
