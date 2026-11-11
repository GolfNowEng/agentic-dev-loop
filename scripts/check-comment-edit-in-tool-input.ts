/**
 * PreToolUse hook checker invoked by
 * `.claude/hooks/block-comment-edit-in-place.sh`. Detects any tool call
 * that would edit an existing Jira/GitHub comment in place instead of
 * creating a new one -- the root cause behind the TARS-1450 comment-
 * thread-ordering incident (2026-09-19, see CHANGELOG.md): Jira and
 * GitHub both render comment threads in creation-time order, not edit
 * order, so an in-place edit leaves the newest actual state pinned at its
 * original (often much earlier) position while newer human replies land
 * below it, making the two surfaces look out of sync even when the
 * underlying pipeline state is correct. SKILL.md's "Setup: idempotent
 * re-refinement" / "Ticket content protocol" item 5 / "Bouncing" now all
 * say "always post a new comment" in prose; this hook is the real
 * code-level backstop behind that prose, mirroring
 * `check-secret-in-tool-input.ts`'s own contract:
 *
 *   0 -- clean, not an edit-in-place call.
 *   1 -- an edit-in-place call was detected.
 *   2 -- the check itself failed (malformed/non-JSON stdin, unexpected
 *        exception) -- distinct from "edit detected" so the calling hook
 *        script fails *closed* (deny) on this case too.
 *
 * Two shapes recognized:
 *   - `mcp__atlassian__addCommentToJiraIssue` called with a non-empty
 *     `commentId` -- that parameter is what turns the call from "create a
 *     new comment" into "update the named comment in place."
 *   - A `Bash` call that PATCHes an existing GitHub issue comment
 *     (`gh api .../issues/comments/<id> ... -X PATCH` / `--method PATCH`)
 *     or uses `gh issue comment --edit-last`.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whole-word check, case-insensitive -- mirrors the sibling secret-scan
 * hook's `isGhIssueWrite` helper.
 */
function hasWord(command: string, word: string): boolean {
  return new RegExp(`(?:^|\\W)${word}(?:$|\\W)`, "i").test(command);
}

function isGhCommentEditInPlace(command: string): boolean {
  const isPatchMethod = /-X\s*PATCH|--method\s+PATCH/i.test(command);
  const targetsIssueComment = /issues\/comments\//i.test(command);
  if (hasWord(command, "gh") && hasWord(command, "api") && isPatchMethod && targetsIssueComment) {
    return true;
  }

  if (
    hasWord(command, "gh") &&
    hasWord(command, "issue") &&
    hasWord(command, "comment") &&
    /--edit-last/i.test(command)
  ) {
    return true;
  }

  return false;
}

/**
 * Pure decision function, unit-testable without touching stdin/process.
 * `stdin` is the raw JSON string the hook receives from Claude Code.
 */
export function decideExitCode(stdin: string): 0 | 1 | 2 {
  if (typeof stdin !== "string") return 2;
  if (stdin.trim().length === 0) return 0;

  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return 2;
  }

  try {
    const record = payload as Record<string, unknown> | null;
    const toolInput = record?.tool_input as Record<string, unknown> | null | undefined;
    if (toolInput === null || toolInput === undefined) return 0;

    const toolName = record?.tool_name;

    if (toolName === "mcp__atlassian__addCommentToJiraIssue") {
      const commentId = toolInput.commentId;
      return typeof commentId === "string" && commentId.length > 0 ? 1 : 0;
    }

    if (toolName === "Bash") {
      const command = toolInput.command;
      if (typeof command !== "string" || command.length === 0) return 0;
      return isGhCommentEditInPlace(command) ? 1 : 0;
    }

    return 0;
  } catch {
    return 2;
  }
}

/**
 * Maps decideExitCode's internal 0|1|2 contract to the actual process exit
 * code, choosing 3 (not 1) for "edit detected" -- same reasoning as
 * check-secret-in-tool-input.ts's own PROCESS_EXIT_CODE: Node's default
 * exit code for a totally uncaught crash is 1, so using 1 here would make
 * a broken checker indistinguishable from one that correctly detected an
 * edit-in-place call.
 */
const PROCESS_EXIT_CODE = { 0: 0, 1: 3, 2: 2 } as const;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const stdin = Buffer.concat(chunks).toString("utf8");
  process.exit(PROCESS_EXIT_CODE[decideExitCode(stdin)]);
}

/**
 * Only run as a script when invoked directly (not when imported by
 * tests) -- same symlink-safe realpath comparison as the sibling checker,
 * for the same reason (see that file's own comment).
 */
function isRunAsScript(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  process.on("uncaughtException", () => process.exit(2));
  process.on("unhandledRejection", () => process.exit(2));
  main().catch(() => process.exit(2));
}
