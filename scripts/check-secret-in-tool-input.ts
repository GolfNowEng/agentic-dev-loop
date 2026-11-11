/**
 * PreToolUse hook checker shared by `.claude/hooks/block-secret-comments.sh`
 * and `.claude/hooks/block-github-secret-writes.sh`. One checker for both
 * roles' write surfaces (the union of v1 dev-loop's and research-loop's
 * checkers):
 *
 *   - `Bash` calls: scans `tool_input.command` when it is a `gh pr
 *     create/edit` (dev's PR title/body) or `gh issue create/edit/comment`
 *     (research's mirror Issue) invocation. Every other Bash command is 0.
 *   - Any other tool with a `tool_input` (the `mcp__atlassian__*` Jira/
 *     Confluence writes the settings.json matcher routes here): scans the
 *     whole `tool_input` object, serialized, so a secret nested anywhere
 *     (fields.description, commentBody, comment, ...) is caught.
 *
 * Reads the hook's stdin JSON payload and communicates its verdict purely
 * via exit code -- no stdout, so nothing it prints can itself become a
 * leak channel:
 *
 *   0 -- clean: not a scanned write, or no secret-shaped content.
 *   1 -- secret-shaped content found (process exit code 3, see below).
 *   2 -- the check itself failed (malformed/non-JSON stdin, unexpected
 *        exception) -- distinct from "found a secret" so the calling hook
 *        script fails *closed* (deny) on this case too, rather than
 *        silently treating "couldn't tell" the same as "found nothing".
 *
 * The untrusted content is read here purely as JSON *data* (via JSON.parse
 * on a string read from stdin) -- never interpolated into a shell command
 * or a dynamically-built source string. PR bodies, Jira comments and
 * ticket text are adversarially-influenceable; backticks/`${}`/quotes in
 * them must never be able to execute as code in this process, which has
 * this repo's real credentials in its environment.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { containsSecret } from "../src/core/redact.ts";

function hasWord(command: string, word: string): boolean {
  return new RegExp(`(?:^|\\W)${word}(?:$|\\W)`).test(command);
}

/**
 * Whole-word membership checks -- the same logic as the hook scripts'
 * `grep -qw` pre-filters, kept here too so the unit tests exercise the
 * recognition directly. Not a security boundary by itself: over-matching
 * (a command that merely mentions "gh pr create" in a string literal)
 * just costs one extra scan, never a missed detection.
 */
function isGhPrWrite(command: string): boolean {
  return hasWord(command, "gh") && hasWord(command, "pr") && (hasWord(command, "create") || hasWord(command, "edit"));
}

function isGhIssueWrite(command: string): boolean {
  return (
    hasWord(command, "gh") &&
    hasWord(command, "issue") &&
    (hasWord(command, "create") || hasWord(command, "edit") || hasWord(command, "comment"))
  );
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
    const toolInput = record?.tool_input;
    if (toolInput === null || toolInput === undefined) return 0;
    const toolName = record?.tool_name;

    if (toolName === "Bash") {
      const command = (toolInput as Record<string, unknown>)?.command;
      if (typeof command !== "string" || command.length === 0) return 0;
      if (!isGhPrWrite(command) && !isGhIssueWrite(command)) return 0;
      return containsSecret(command) ? 1 : 0;
    }

    // Only MCP tools are scanned whole; the settings.json matcher decides
    // which ones reach this checker at all. A non-MCP, non-Bash tool
    // (Read, Edit, ...) is not a write surface this hook guards.
    if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return 0;
    const scanned = JSON.stringify(toolInput);
    if (!scanned) return 0;
    return containsSecret(scanned) ? 1 : 0;
  } catch {
    return 2;
  }
}

/**
 * Maps decideExitCode's internal 0|1|2 contract to the actual process exit
 * code, deliberately choosing 3 (not 1) for "secret found" -- Node's own
 * default exit code for a totally uncaught crash (a syntax error, or a
 * module-load-time throw, happening before any in-process handler below
 * even runs) is 1. If "secret found" also used 1, a completely broken
 * checker crashing would be indistinguishable from one that correctly
 * found a secret, misleading whoever reads the denial reason. Any exit
 * code other than 0 or 3 reliably means "something about the check
 * failed," regardless of how it failed.
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
 * tests). Compares realpaths, not raw strings or file:// URLs:
 * `import.meta.url` is Node's own module identity and is symlink-
 * resolved, but `process.argv[1]` is the literal path the process was
 * invoked with -- when that path passes through a symlink, any raw
 * string/URL comparison silently never matches, main() never runs, and
 * the process exits 0 having never read stdin (a fail-OPEN the hook
 * would read as "clean, allow"). realpathSync() resolves both symlinks
 * and the percent-encoding case the previous pathToFileURL()-based
 * comparison already handled, so this covers both failure modes with
 * one mechanism. Not yet observed live in this repo (this repo's own
 * directory isn't a symlink today), but confirmed live in the sibling
 * `skills` repo's copy of this file, reached through
 * `~/.claude/skills -> .../Desktop/Repos/skills`.
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
  // Belt-and-suspenders fail-closed guard: an exception anywhere in this
  // process must still report exit code 2 ("check failed"), never fall
  // through to whatever exit code Node happens to produce on its own.
  process.on("uncaughtException", () => process.exit(2));
  process.on("unhandledRejection", () => process.exit(2));
  main().catch(() => process.exit(2));
}
