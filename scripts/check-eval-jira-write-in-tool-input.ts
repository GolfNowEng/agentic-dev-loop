/**
 * PreToolUse hook checker invoked by
 * `.claude/hooks/block-non-eval-jira-writes.sh`: the eval boundary (Task 16,
 * spec §9.2). The hook only calls this when DEVLOOP_EVAL_KEYS is set (by
 * `evals/run.sh`, to the keys it created); it is then the code-level
 * guarantee that a `claude -p` spawned during an eval writes to no Jira
 * ticket except the eval's own.
 *
 * Rules, for Atlassian MCP tools only (anything else is allowed). A tool is
 * Atlassian when its server is `atlassian` or `mcp-gateway` (the sbx sandbox's
 * proxy), or its bare name is a known Atlassian tool under any server; both
 * the host (v1) and Atlassian's /v2/mcp tool names are known:
 *   - a read tool (READ_TOOLS) is always allowed;
 *   - a keyed write (KEYED_WRITE_TOOLS) is allowed only when every key it
 *     names (`issueIdOrKey`, `issueKey`; at least one) is in the list;
 *   - `createIssueLink` is allowed only when both `inwardIssue` and
 *     `outwardIssue` are in the list;
 *   - `createJiraIssue` (a follow-up ticket filed during an eval) is
 *     allowed only when ALL hold (allowedCreate): the project is TARS
 *     (`projectKey` and/or `additional_fields.project`; at least one, and
 *     every one given); `summary`
 *     starts with `[dev-loop-eval]`; `additional_fields.labels` includes
 *     `dev-loop-eval` (so evals/reset.sh can find it); no parent, or a
 *     listed one (`parent`, `additional_fields.parent`); no `transition`;
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
export const EVAL_LABEL = "dev-loop-eval";
export const EVAL_PROJECT_KEY = "TARS";

/** Servers whose every tool is treated as Atlassian (unknown ones are denied while active). */
const ATLASSIAN_SERVERS: ReadonlySet<string> = new Set(["atlassian", "mcp-gateway"]);

export const READ_TOOLS: ReadonlySet<string> = new Set([
  // v1 (host connector)
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
  // v2 (/v2/mcp, e.g. through the sbx MCP gateway)
  "discover",
  "executeRead",
  "getCollaborators",
  "getConfluenceContent",
  "getGraphContext",
  "getGraphObject",
  "getLoomObjectsContent",
  "getPeopleInfo",
  "getWorkActivity",
  "getWorkPortfolio",
  "listJiraIssueComments",
  "searchConfluence",
]);

export const KEYED_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "addCommentToJiraIssue",
  "addOrEditJiraIssueComment",
  "editJiraIssue",
  "transitionJiraIssue",
  "addWorklogToJiraIssue",
]);

const LINK_TOOL = "createIssueLink";
const CREATE_TOOL = "createJiraIssue";

const KNOWN: ReadonlySet<string> = new Set([...READ_TOOLS, ...KEYED_WRITE_TOOLS, LINK_TOOL, CREATE_TOOL]);

/** The bare Atlassian tool name, or undefined for a tool this hook does not police. */
function atlassianName(toolName: string): string | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m) return undefined;
  const [, server, name] = m;
  return ATLASSIAN_SERVERS.has(server) || KNOWN.has(name) ? name : undefined;
}

export function parseKeys(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0),
  );
}

const listed = (keys: Set<string>, v: unknown): boolean => typeof v === "string" && keys.has(v);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A Jira ref given as a key string or `{ key }`. */
const refKey = (v: unknown): unknown => (isRecord(v) ? v.key : v);

/** The createJiraIssue rule (see the header): every condition must hold. */
function allowedCreate(ti: Record<string, unknown>, keys: Set<string>): boolean {
  const extra = ti.additional_fields;
  if (extra !== undefined && !isRecord(extra)) return false;
  const af = extra ?? {};
  const projects = [...("projectKey" in ti ? [ti.projectKey] : []), ...("project" in af ? [refKey(af.project)] : [])];
  if (projects.length === 0 || !projects.every((p) => p === EVAL_PROJECT_KEY)) return false;
  if (typeof ti.summary !== "string" || !ti.summary.startsWith(EVAL_SUMMARY_PREFIX)) return false;
  if (!Array.isArray(af.labels) || !af.labels.includes(EVAL_LABEL)) return false;
  for (const parent of [ti.parent, af.parent]) {
    if (parent !== undefined && !listed(keys, refKey(parent))) return false;
  }
  if ("transition" in ti || "transition" in af) return false;
  return true;
}

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
    const name = atlassianName(toolName);
    if (name === undefined) return 0;
    if (READ_TOOLS.has(name)) return 0;

    const input = record.tool_input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) return 2;
    const ti = input as Record<string, unknown>;
    const keys = parseKeys(keysEnv);

    if (KEYED_WRITE_TOOLS.has(name)) {
      const named = ["issueIdOrKey", "issueKey"].filter((f) => f in ti).map((f) => ti[f]);
      if (named.length === 0) return 1;
      return named.every((k) => listed(keys, k)) ? 0 : 1;
    }
    if (name === LINK_TOOL) {
      return listed(keys, ti.inwardIssue) && listed(keys, ti.outwardIssue) ? 0 : 1;
    }
    if (name === CREATE_TOOL) return allowedCreate(ti, keys) ? 0 : 1;
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
