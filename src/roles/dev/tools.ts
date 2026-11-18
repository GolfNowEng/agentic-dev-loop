import { allowedToolsFor } from "../../core/atlassian-tools.ts";

/**
 * --allowedTools for the dev role's `claude -p` (ticket-to-pr), moved
 * verbatim from dev-loop's v1 src/main.ts. Never unioned with research's.
 *
 * --permission-mode acceptEdits only auto-approves file *edits* (Edit/
 * Write), not MCP tool calls, Bash, or plain file reads -- Atlassian MCP
 * calls (getJiraIssue, etc.), every Bash invocation (git worktree/push,
 * running the test suite, lint/typecheck/build, `gh pr create`), and Read/
 * Grep/Glob all still prompt for approval, which hangs/fails in headless
 * -p mode with no human to answer it. ticket-to-pr only ever reads the
 * ticket itself via MCP (fetches summary/description/comments/status); it
 * never transitions status, moves epics, or writes comments through MCP
 * -- the loop runner's REST client handles all of that. The one exception
 * (Ruling 30): createJiraIssue + createIssueLink, so a run blocked by
 * pre-existing failures can file the linked follow-up ticket. Both go
 * through the PreToolUse secret-content hooks in .claude/settings.json. Bash is allowed
 * broadly since every TDD phase (Red/Green/Verify/PR) assumes real
 * command execution inside the isolated per-run worktree. Read/Grep/Glob
 * are allowed for the same reason Edit/Write already are: the skill reads
 * source and test files constantly while planning and implementing, and
 * Edit itself refuses to touch a file that hasn't been Read first in-
 * session -- confirmed live on TARS-1341, which exhausted its retries
 * stuck on exactly that Read prompt and exited with no verdict.json.
 *
 * The Atlassian names come from src/core/atlassian-tools.ts (the one list the
 * hooks are tested against); this is the host-connector form (both server
 * namings, since the connector may be v1 or /v2/mcp).
 */
export const ALLOWED_TOOLS = allowedToolsFor("dev");
