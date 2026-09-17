/**
 * PreToolUse hook checker invoked by `.claude/hooks/block-secret-comments.sh`
 * for every Atlassian MCP write call the hook's matcher covers (Jira
 * comments/edits/worklogs/issue links, Confluence page/comment writes).
 * Reads the hook's stdin JSON payload, scans the whole `tool_input` object
 * for anything `redactSecrets()` would redact, and communicates its
 * verdict purely via exit code -- no stdout, so nothing it prints can
 * itself become a leak channel:
 *
 *   0 -- clean, no secret-shaped content found.
 *   1 -- secret-shaped content found.
 *   2 -- the check itself failed (malformed/non-JSON stdin, unexpected
 *        exception) -- distinct from "found a secret" so the calling hook
 *        script can fail *closed* (deny) on this case too, rather than
 *        silently treating "couldn't tell" the same as "found nothing".
 *
 * The untrusted tool_input content is read here purely as JSON *data*
 * (via JSON.parse on a string read from stdin) -- never interpolated
 * into a shell command or a dynamically-built source string. That is
 * deliberate: comment/ticket text is adversarially-influenceable (per
 * this pipeline's own threat model -- see SKILL.md), and interpolating
 * it into an `-e`-style invocation would let content containing
 * backticks/`${}`/quotes break out of the intended source into arbitrary
 * code execution in this process, which has this repo's real credentials
 * in its environment.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { containsSecret } from "../src/redact.ts";

/**
 * Whole-word membership check -- mirrors dev-loop's own isGhPrWrite
 * recognizer (scripts/check-secret-in-tool-input.ts in that repo), adapted
 * for "gh issue create/edit/comment" instead of "gh pr create/edit".
 * Over-matching here is harmless (see that repo's own comment for why) --
 * it just costs one extra scan pass, never a missed detection.
 */
function isGhIssueWrite(command: string): boolean {
  const hasWord = (word: string): boolean =>
    new RegExp(`(?:^|\\W)${word}(?:$|\\W)`).test(command);
  return (
    hasWord("gh") &&
    hasWord("issue") &&
    (hasWord("create") || hasWord("edit") || hasWord("comment"))
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
    const toolInput = (payload as Record<string, unknown> | null)?.tool_input;
    if (toolInput === null || toolInput === undefined) return 0;

    const record = payload as Record<string, unknown> | null;
    const toolName = record?.tool_name;
    if (toolName === "Bash") {
      const command = (toolInput as Record<string, unknown>)?.command;
      if (typeof command !== "string" || command.length === 0) return 0;
      if (!isGhIssueWrite(command)) return 0;
      return containsSecret(command) ? 1 : 0;
    }

    const scanned = JSON.stringify(toolInput);
    if (!scanned) return 0;
    return containsSecret(scanned) ? 1 : 0;
  } catch {
    return 2;
  }
}

/**
 * Maps decideExitCode's internal 0|1|2 contract to the actual process exit
 * code, deliberately choosing 3 (not 1) for "secret found". Node's own
 * default exit code for a totally uncaught crash (e.g. a syntax error or a
 * module-load-time throw, which happens before any in-process handler
 * below even has a chance to run) is 1 -- if "secret found" also used 1,
 * a completely broken checker script would be indistinguishable from one
 * that correctly found a secret, and the hook would report the wrong
 * denial reason to the agent (misleadingly implying a real secret was
 * found rather than "the check itself is broken"). Using 3 here means
 * *any* other exit code (0 excepted) reliably means "something about the
 * check failed" to the calling hook script, regardless of how it failed.
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
 * tests). Compares realpaths, not raw strings: `import.meta.url` is
 * Node's own module identity and is symlink-resolved, but
 * `process.argv[1]` is the literal path the process was invoked with --
 * when that path passes through a symlink, the raw-string comparison
 * silently never matches, main() never runs, and the process exits 0
 * having never read stdin. That failure mode is worse than a crash here:
 * a hook that silently always allows is indistinguishable from one that
 * correctly checked and found nothing. Not yet observed live in this
 * repo (this repo's own directory isn't a symlink today), but confirmed
 * live in the sibling `skills` repo's copy of this file, reached through
 * `~/.claude/skills -> .../Desktop/Repos/skills` -- fixed here too for
 * consistency, same reasoning as the KEY-matching fix above.
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
  // process (not just inside main()'s own await chain) must still report
  // exit code 2 ("check failed"), not fall through to whatever exit code
  // Node happens to produce on its own.
  process.on("uncaughtException", () => process.exit(2));
  process.on("unhandledRejection", () => process.exit(2));
  main().catch(() => process.exit(2));
}
