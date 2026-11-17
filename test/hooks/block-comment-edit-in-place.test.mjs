// End-to-end test of .claude/hooks/block-comment-edit-in-place.sh, driven
// via real piped stdin JSON the same shape Claude Code sends a PreToolUse
// hook. Moved from research-loop/test/hooks/ (every original case kept).
// Run with:
//   npm run test:hooks
//   node test/hooks/block-comment-edit-in-place.test.mjs

import { BROKEN_CHECKER, runHook, withTempLayout, withOutsideCwd, check, finish } from "./_helpers.mjs";

const HOOK = "block-comment-edit-in-place.sh";
const run = (stdin, opts) => runHook(HOOK, stdin, opts);
const bash = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

{
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__addCommentToJiraIssue",
    tool_input: { cloudId: "x", issueIdOrKey: "TARS-1450", commentBody: "updated", commentId: "1039214" },
  });
  const result = run(stdin);
  check("addCommentToJiraIssue with commentId: exit code is 2", result.status === 2, `got ${result.status}`);
  check("addCommentToJiraIssue with commentId: stderr is non-empty", result.stderr.trim().length > 0);
}

{
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__addCommentToJiraIssue",
    tool_input: { cloudId: "x", issueIdOrKey: "TARS-1450", commentBody: "fresh comment" },
  });
  const result = run(stdin);
  check("addCommentToJiraIssue without commentId: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

{
  const result = run(bash("gh api repos/fandango/webtarsthree/issues/comments/5735844223 -X PATCH -f body='updated'"));
  check("gh api PATCH issue comment: exit code is 2", result.status === 2, `got ${result.status}`);
}

{
  const result = run(bash("gh issue comment 439 --edit-last --body 'updated'"));
  check("gh issue comment --edit-last: exit code is 2", result.status === 2, `got ${result.status}`);
}

{
  const result = run(bash("gh issue comment 439 --body 'fresh comment'"));
  check("fresh gh issue comment: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

{
  const result = run(bash("npm test"));
  check("unrelated Bash command: exit code is 0", result.status === 0, `got ${result.status}`);
}

{
  const stdin = JSON.stringify({ tool_name: "mcp__atlassian__getJiraIssue", tool_input: { cloudId: "x", issueIdOrKey: "TARS-1450" } });
  const result = run(stdin);
  check("getJiraIssue: exit code is 0", result.status === 0, `got ${result.status}`);
}

// The same rule under the sbx gateway's server name and Atlassian's v2 tool name.
for (const tool of ["mcp__mcp-gateway__addOrEditJiraIssueComment", "mcp__mcp-gateway__addCommentToJiraIssue", "mcp__atlassian__addOrEditJiraIssueComment"]) {
  const edit = run(JSON.stringify({ tool_name: tool, tool_input: { cloudId: "x", issueIdOrKey: "TARS-1450", commentBody: "updated", commentId: "1039214" } }));
  check(`${tool} with commentId: exit code is 2`, edit.status === 2, `got ${edit.status}`);
  const fresh = run(JSON.stringify({ tool_name: tool, tool_input: { cloudId: "x", issueIdOrKey: "TARS-1450", commentBody: "fresh" } }));
  check(`${tool} without commentId: exit code is 0`, fresh.status === 0, `got ${fresh.status}, stderr: ${fresh.stderr}`);
}

// Checker failures fail closed, against a throwaway copy of the hook.
{
  const stdin = JSON.stringify({ tool_name: "mcp__atlassian__addCommentToJiraIssue", tool_input: { commentId: "123" } });
  withTempLayout(HOOK, { "check-comment-edit-in-tool-input.ts": BROKEN_CHECKER }, (path, root) => {
    const result = run(stdin, { path, env: { CLAUDE_PROJECT_DIR: root } });
    check("checker-failure: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}`);
    check(
      "checker-failure: stderr reason is distinguishable from the edit-detected reason",
      result.stderr.includes("could not verify"),
      result.stderr,
    );
  });
  withTempLayout(HOOK, {}, (path, root) => {
    const result = run(stdin, { path, env: { CLAUDE_PROJECT_DIR: root } });
    check("checker missing: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}`);
  });
}

// CLAUDE_PROJECT_DIR unset must not abort `set -u` with a fail-open exit 1.
{
  const stdin = JSON.stringify({ tool_name: "mcp__atlassian__addCommentToJiraIssue", tool_input: { commentId: "123" } });
  const result = run(stdin, { env: { CLAUDE_PROJECT_DIR: undefined } });
  check("CLAUDE_PROJECT_DIR unset: edit-in-place still denied (exit 2)", result.status === 2, `got ${result.status}, stderr: ${result.stderr}`);
}

// Run from a cwd outside the repo (a skill that cd'd into its worktree).
withOutsideCwd((cwd) => {
  const deny = run(bash("gh issue comment 439 --edit-last --body x"), { cwd });
  check("cwd outside the repo: --edit-last denied", deny.status === 2, `got ${deny.status}, stderr: ${deny.stderr}`);
  const allow = run(bash("gh issue comment 439 --body x"), { cwd });
  check("cwd outside the repo: fresh comment allowed (checker resolved)", allow.status === 0, `got ${allow.status}, stderr: ${allow.stderr}`);
});

finish();
