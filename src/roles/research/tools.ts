/**
 * --allowedTools for the research role's `claude -p` (ticket-refine), moved
 * verbatim from research-loop's v1 src/main.ts. Never unioned with dev's.
 *
 * --permission-mode acceptEdits only auto-approves file *edits* (Edit/
 * Write), not MCP tool calls, Bash, or plain file reads -- Atlassian MCP
 * calls (getJiraIssue, etc.), every Bash invocation (git fetch/worktree,
 * running the target repo's test suite, starting/stopping its dev
 * server, throwaway repro scripts), and Read/Grep/Glob all still prompt
 * for approval, which hangs/fails in headless -p mode with no human to
 * answer it. Explicitly allow the specific Atlassian MCP tools this
 * skill actually uses (read + comment + description writes --
 * ticket-refine never transitions status or swaps labels itself, the loop
 * runner's REST client does that) plus Bash broadly, since Ground's
 * whole design assumes real command execution inside the isolated
 * per-run worktree. Read/Grep/Glob are allowed for the same reason:
 * recon-agent and the synthesis phase read source files in the target
 * repo constantly, and Edit itself refuses to touch a file that hasn't
 * been Read first in-session -- the same gap that stalled dev-loop's
 * ticket-to-pr headless runs (see dev-loop's CHANGELOG.md, 2026-08-27)
 * with no verdict.json ever written. Also allow the read-only Rovo/
 * Confluence lookups (search, getConfluencePage, searchConfluenceUsingCql)
 * -- Interpret's "exhaust available Jira/Confluence context" step and
 * Ground's precedent-checking both reach for these when a ticket
 * references prior art or a linked doc, and their absence produced a
 * real agent_error (verdict.json never written) on TARS-1391's first
 * attempt on 2026-09-02, confirmed via that run's own permission_denials.
 */
export const ALLOWED_TOOLS = [
  "mcp__atlassian__getAccessibleAtlassianResources",
  "mcp__atlassian__getJiraIssue",
  "mcp__atlassian__searchJiraIssuesUsingJql",
  "mcp__atlassian__addCommentToJiraIssue",
  "mcp__atlassian__editJiraIssue",
  "mcp__atlassian__search",
  "mcp__atlassian__getConfluencePage",
  "mcp__atlassian__searchConfluenceUsingCql",
  "Bash",
  "Read",
  "Grep",
  "Glob",
].join(",");
