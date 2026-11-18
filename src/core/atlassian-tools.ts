/**
 * The one list of Atlassian MCP tools the pipeline uses, so the per-role
 * `--allowedTools` lists and the PreToolUse hooks in .claude/settings.json
 * cannot drift apart (test/core/atlassian-tools.test.ts ties them together).
 *
 * The same Atlassian server shows up under two tool namings:
 *   - "v1": the host connector (mcp__atlassian__*), the names the skills use.
 *   - "v2": Atlassian's /v2/mcp server, which some tools were renamed on
 *     (addCommentToJiraIssue -> addOrEditJiraIssueComment, ...). A sandbox
 *     adapter that proxies MCP reports which naming and server name it uses.
 *
 * The allowlist decides which tools a role may call (an unlisted name is
 * denied). The hooks decide whether a write's content is safe; they match the
 * bare tool name under ANY server, so a renamed server can never route a write
 * around the secret scan. A v2 tool with no named equivalent (createIssueLink)
 * stays unavailable rather than going through a generic executeWrite.
 */

import type { Role } from "./types.ts";

/** "both": the host connector, which may be either server version (v1 or Atlassian's /v2/mcp). */
export type AtlassianNaming = "v1" | "v2" | "both";

export interface AtlassianTool {
  v1?: string;
  v2?: string;
  access: "read" | "write";
  roles: readonly Role[];
}

/** Ordered: filtering by role gives each role's v1 allowlist in its original order. */
export const ATLASSIAN_TOOLS: readonly AtlassianTool[] = [
  { v1: "getAccessibleAtlassianResources", v2: "getAccessibleAtlassianResources", access: "read", roles: ["research", "dev"] },
  { v1: "getJiraIssue", v2: "getJiraIssue", access: "read", roles: ["research", "dev"] },
  { v1: "searchJiraIssuesUsingJql", v2: "searchJiraIssuesUsingJql", access: "read", roles: ["research"] },
  { v1: "addCommentToJiraIssue", v2: "addOrEditJiraIssueComment", access: "write", roles: ["research"] },
  { v1: "editJiraIssue", v2: "editJiraIssue", access: "write", roles: ["research"] },
  { v1: "search", v2: "search", access: "read", roles: ["research"] },
  { v1: "getConfluencePage", v2: "getConfluenceContent", access: "read", roles: ["research"] },
  { v1: "searchConfluenceUsingCql", v2: "searchConfluence", access: "read", roles: ["research"] },
  { v1: "createJiraIssue", v2: "createJiraIssue", access: "write", roles: ["dev"] },
  { v1: "createIssueLink", access: "write", roles: ["dev"] },
  // v2 only: getJiraIssue embeds at most 20 comments and cannot page them.
  { v2: "listJiraIssueComments", access: "read", roles: ["research", "dev"] },
];

/** The role's Atlassian tool names (no mcp__ prefix) in the given naming. */
export function atlassianToolNames(role: Role, naming: AtlassianNaming): string[] {
  const pick = (t: AtlassianTool): string[] => (naming === "both" ? [t.v1, t.v2] : [t[naming]]).filter((n): n is string => n !== undefined);
  return [...new Set(ATLASSIAN_TOOLS.filter((t) => t.roles.includes(role)).flatMap(pick))];
}

/** Where a role's Atlassian tools live: the MCP server name and its tool naming. */
export interface AtlassianMcp {
  server: string;
  naming: AtlassianNaming;
}

/**
 * The host connector: what a run outside any sandbox sees. Its server version
 * is whatever the person connected (`claude mcp add atlassian ...`), so both
 * namings are allowed. TARS-1640 (2026-11-17): the connector was /v2/mcp, the
 * allowlist had only `addCommentToJiraIssue`, and research's ✅ comment was
 * denied as `addOrEditJiraIssueComment`. The write hooks match both names.
 */
export const HOST_ATLASSIAN_MCP: AtlassianMcp = { server: "atlassian", naming: "both" };

const BUILTIN_TOOLS = ["Bash", "Read", "Grep", "Glob"];

/** The comma-joined `--allowedTools` value for a role. */
export function allowedToolsFor(role: Role, mcp: AtlassianMcp = HOST_ATLASSIAN_MCP): string {
  return [...atlassianToolNames(role, mcp.naming).map((n) => `mcp__${mcp.server}__${n}`), ...BUILTIN_TOOLS].join(",");
}

/**
 * Every Atlassian tool name, in either naming, that can write: what the
 * secret-scan / comment-edit matcher in .claude/settings.json must cover. A
 * superset of the allowlisted writes, so a tool a session allows by hand is
 * still scanned.
 */
export const ATLASSIAN_WRITE_NAMES: readonly string[] = [
  // v1
  "addCommentToJiraIssue",
  "editJiraIssue",
  "addWorklogToJiraIssue",
  "createIssueLink",
  "createJiraIssue",
  "createConfluencePage",
  "updateConfluencePage",
  "createConfluenceFooterComment",
  "createConfluenceInlineComment",
  "transitionJiraIssue",
  // v2
  "addOrEditJiraIssueComment",
  "createConfluenceContent",
  "updateConfluenceContent",
  "addGraphContext",
  "executeWrite",
  "executeDestructive",
];

/** The comment-write tools whose `commentId` input edits an existing comment in place. */
export const COMMENT_TOOL_NAMES: ReadonlySet<string> = new Set(["addCommentToJiraIssue", "addOrEditJiraIssueComment"]);

/** `mcp__<server>__<name>` -> `<name>`; undefined for a non-MCP tool. */
export function bareToolName(toolName: string): string | undefined {
  return /^mcp__.+?__(.+)$/.exec(toolName)?.[1];
}
