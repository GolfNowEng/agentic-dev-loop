/**
 * PreToolUse hook checker invoked by
 * `.claude/hooks/block-non-eval-jira-writes.sh`: the eval boundary (Task 16,
 * spec §9.2). The hook only calls this when DEVLOOP_EVAL_KEYS is set (by
 * `evals/run.sh`, to the keys it created); it is then the code-level
 * guarantee that a `claude -p` spawned during an eval writes to no Jira
 * ticket except the eval's own.
 *
 * Rules, for `mcp__atlassian__*` tools only (anything else is allowed):
 *   - a read tool (READ_TOOLS) is always allowed;
 *   - a keyed write (KEYED_WRITE_TOOLS) is allowed only when every key it
 *     names (`issueIdOrKey`, `issueKey`; at least one) is in the list;
 *   - `createIssueLink` is allowed only when both `inwardIssue` and
 *     `outwardIssue` are in the list;
 *   - `createJiraIssue` is allowed only when `summary` starts with
 *     `[dev-loop-eval]` (a follow-up ticket filed during an eval);
 *   - any other atlassian tool (Confluence writes, a tool added later) is
 *     denied: unknown means unverified.
 *
 * Contract, same as the sibling checkers:
 *   0 -- allowed.
 *   1 -- denied by a rule.
 *   2 -- the check itself failed (empty/non-JSON stdin, no tool_name, a
 *        write with no tool_input, unexpected exception); the hook denies.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EVAL_SUMMARY_PREFIX = "[dev-loop-eval]";

const P = "mcp__atlassian__";

export const READ_TOOLS: ReadonlySet<string> = new Set(
  [
    "atlassianUserInfo",
    "fetch",
    "getAccessibleAtlassianResources",
    "getConfluenceCommentChildren",
    "getConfluencePage",
    "getConfluencePageDescendants",
    "getConfluencePageFooterComments",
    "getConfluencePageInlineComments",
    "getConfluenceSpaces",
    "getContentFormatGuide",
    "getIssueLinkTypes",
    "getJiraIssue",
    "getJiraIssueRemoteIssueLinks",
    "getJiraIssueTypeMetaWithFields",
    "getJiraProjectIssueTypesMetadata",
    "getPagesInConfluenceSpace",
    "getTransitionsForJiraIssue",
    "getVisibleJiraProjects",
    "lookupJiraAccountId",
    "search",
    "searchConfluenceUsingCql",
    "searchJiraIssuesUsingJql",
  ].map((t) => P + t),
);

export const KEYED_WRITE_TOOLS: ReadonlySet<string> = new Set(
  ["addCommentToJiraIssue", "editJiraIssue", "transitionJiraIssue", "addWorklogToJiraIssue"].map((t) => P + t),
);

const LINK_TOOL = `${P}createIssueLink`;
const CREATE_TOOL = `${P}createJiraIssue`;

export function parseKeys(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0),
  );
}

const listed = (keys: Set<string>, v: unknown): boolean => typeof v === "string" && keys.has(v);

/** Pure decision. `stdin` is the hook's raw JSON; `keysEnv` is DEVLOOP_EVAL_KEYS. */
export function decideExitCode(stdin: string, keysEnv: string): 0 | 1 | 2 {
  if (typeof stdin !== "string" || stdin.trim().length === 0) return 2;
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return 2;
  }
  try {
    if (typeof payload !== "object" || payload === null) return 2;
    const record = payload as Record<string, unknown>;
    const toolName = record.tool_name;
    if (typeof toolName !== "string" || toolName.length === 0) return 2;
    if (!toolName.startsWith(P)) return 0;
    if (READ_TOOLS.has(toolName)) return 0;

    const input = record.tool_input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) return 2;
    const ti = input as Record<string, unknown>;
    const keys = parseKeys(keysEnv);

    if (KEYED_WRITE_TOOLS.has(toolName)) {
      const named = ["issueIdOrKey", "issueKey"].filter((f) => f in ti).map((f) => ti[f]);
      if (named.length === 0) return 1;
      return named.every((k) => listed(keys, k)) ? 0 : 1;
    }
    if (toolName === LINK_TOOL) {
      return listed(keys, ti.inwardIssue) && listed(keys, ti.outwardIssue) ? 0 : 1;
    }
    if (toolName === CREATE_TOOL) {
      return typeof ti.summary === "string" && ti.summary.startsWith(EVAL_SUMMARY_PREFIX) ? 0 : 1;
    }
    return 1;
  } catch {
    return 2;
  }
}

/** 3, not 1, for "denied": Node exits 1 on an uncaught crash (see the sibling checkers). */
const PROCESS_EXIT_CODE = { 0: 0, 1: 3, 2: 2 } as const;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const stdin = Buffer.concat(chunks).toString("utf8");
  process.exit(PROCESS_EXIT_CODE[decideExitCode(stdin, process.env.DEVLOOP_EVAL_KEYS ?? "")]);
}

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
