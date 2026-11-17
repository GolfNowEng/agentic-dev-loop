// The one list of Atlassian MCP tools (src/core/atlassian-tools.ts), and the
// drift guard tying it to .claude/settings.json: every write tool, under any
// MCP server name, must reach the secret-scan and comment-edit hooks.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ATLASSIAN_TOOLS, ATLASSIAN_WRITE_NAMES, COMMENT_TOOL_NAMES, atlassianToolNames, bareToolName } from "../../src/core/atlassian-tools.ts";
import { ALLOWED_TOOLS as DEV_TOOLS } from "../../src/roles/dev/tools.ts";
import { ALLOWED_TOOLS as RESEARCH_TOOLS } from "../../src/roles/research/tools.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8")) as {
  hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
};
const groupFor = (hook: string) => settings.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command.endsWith(`/.claude/hooks/${hook}`)));
const matches = (matcher: string, tool: string) => new RegExp(`^(?:${matcher})$`).test(tool);
const SERVERS = ["atlassian", "mcp-gateway", "some-future-server"];

describe("bareToolName", () => {
  it("strips the mcp__<server>__ prefix, whatever the server is called", () => {
    expect(bareToolName("mcp__atlassian__getJiraIssue")).toBe("getJiraIssue");
    expect(bareToolName("mcp__mcp-gateway__addOrEditJiraIssueComment")).toBe("addOrEditJiraIssueComment");
    expect(bareToolName("Bash")).toBeUndefined();
    expect(bareToolName("mcp__noname")).toBeUndefined();
  });
});

describe("atlassianToolNames", () => {
  it("v1 names keep each role's allowlist byte-for-byte", () => {
    expect(atlassianToolNames("research", "v1").map((n) => `mcp__atlassian__${n}`).join(",") + ",Bash,Read,Grep,Glob").toBe(RESEARCH_TOOLS);
    expect(atlassianToolNames("dev", "v1").map((n) => `mcp__atlassian__${n}`).join(",") + ",Bash,Read,Grep,Glob").toBe(DEV_TOOLS);
  });

  it("v2 names map the renamed tools and add the paged comment read", () => {
    expect(atlassianToolNames("research", "v2")).toEqual([
      "getAccessibleAtlassianResources",
      "getJiraIssue",
      "searchJiraIssuesUsingJql",
      "addOrEditJiraIssueComment",
      "editJiraIssue",
      "search",
      "getConfluenceContent",
      "searchConfluence",
      "listJiraIssueComments",
    ]);
    // createIssueLink has no named v2 tool; it stays unavailable rather than going through executeWrite.
    expect(atlassianToolNames("dev", "v2")).toEqual(["getAccessibleAtlassianResources", "getJiraIssue", "createJiraIssue", "listJiraIssueComments"]);
  });

  it("never allows a generic or destructive gateway tool", () => {
    for (const role of ["research", "dev"] as const) {
      for (const n of ["executeWrite", "executeDestructive", "transitionJiraIssue", "mcp-exec", "code-mode"]) {
        expect(atlassianToolNames(role, "v2")).not.toContain(n);
      }
    }
  });
});

describe("drift guard: the list and .claude/settings.json agree", () => {
  it("every allowlisted write tool, in either naming, is a known write name", () => {
    for (const t of ATLASSIAN_TOOLS.filter((t) => t.access === "write")) {
      for (const n of [t.v1, t.v2]) if (n) expect(ATLASSIAN_WRITE_NAMES).toContain(n);
    }
  });

  it("the secret-scan and comment-edit hooks share one matcher covering every write name under any server", () => {
    const secret = groupFor("block-secret-comments.sh").filter((g) => g.matcher !== "Bash");
    expect(secret).toHaveLength(1);
    expect(secret[0].hooks.map((h) => h.command)).toEqual(expect.arrayContaining([expect.stringMatching(/block-comment-edit-in-place\.sh$/)]));
    for (const n of ATLASSIAN_WRITE_NAMES) {
      for (const s of SERVERS) expect(matches(secret[0].matcher, `mcp__${s}__${n}`), `mcp__${s}__${n}`).toBe(true);
    }
    expect(matches(secret[0].matcher, "mcp__atlassian__getJiraIssue")).toBe(false);
  });

  it("the eval boundary hook sees every MCP tool, whatever the server", () => {
    const [g] = groupFor("block-non-eval-jira-writes.sh");
    for (const s of SERVERS) expect(matches(g.matcher, `mcp__${s}__transitionJiraIssue`)).toBe(true);
  });

  it("the comment tools are the ones whose commentId edits in place", () => {
    expect([...COMMENT_TOOL_NAMES].sort()).toEqual(["addCommentToJiraIssue", "addOrEditJiraIssueComment"]);
  });
});
