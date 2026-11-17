// The first-line prefixes of every comment the loop posts to Jira, by role.
// The loop posts under the user's own Jira account, so the author cannot tell
// its comments from a human's: reset deletes a comment only when its first
// line starts with one of these AND it was created inside a run window of
// that role (src/core/reset/run-windows.ts).
//
// Skills and src code that post a Jira comment MUST open it with one of these
// prefixes, or reset will never find (and never delete) it. Add a new prefix
// here before posting a comment with it.
import type { Role } from "./types.ts";

/** src/worker/cycle-steps.ts reportMissingFields: posted by the research claim (Ruling R9: a loop comment). */
const MISSING_FIELDS = "dev-loop could not start this ticket:";

/**
 * src/worker/attempts.ts buildAttemptsCommentAdf: posted at poll time for
 * either role's attempt cap, always with the dev-loop prefix, so it counts for
 * both roles (its window comes from the blocked-attempts record, see run-windows.ts).
 */
const BLOCKED_ATTEMPTS = "❌ dev-loop - blocked-attempts:";

export const LOOP_COMMENT_PREFIXES: Record<Role, readonly string[]> = {
  // ticket-refine's pass pointer and bounce comment (CONTRACT in src/core/contract.ts).
  research: ["✅ research-loop -", "❌ research-loop -", MISSING_FIELDS, BLOCKED_ATTEMPTS],
  // src/roles/dev/code-review.ts buildBounceCommentAdf, src/worker/attempts.ts buildAttemptsCommentAdf.
  dev: ["✅ dev-loop -", "❌ dev-loop -", MISSING_FIELDS],
};

/** Every role whose loop prefix opens `firstLine` (leading `#`s and spaces ignored). */
export function loopCommentRoles(firstLine: string): Role[] {
  const line = firstLine.replace(/^[#\s]+/, "");
  return (["research", "dev"] as const).filter((role) => LOOP_COMMENT_PREFIXES[role].some((p) => line.startsWith(p)));
}

/** The first role whose loop prefix opens `firstLine`, else null. */
export function loopCommentRole(firstLine: string): Role | null {
  return loopCommentRoles(firstLine)[0] ?? null;
}
