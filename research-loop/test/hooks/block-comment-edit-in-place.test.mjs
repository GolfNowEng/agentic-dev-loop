// End-to-end test of .claude/hooks/block-comment-edit-in-place.sh, driven
// via real piped stdin JSON the same shape Claude Code sends a PreToolUse
// hook. Run standalone with:
//   node test/hooks/block-comment-edit-in-place.test.mjs
// (not wired into npm test/vitest -- matches this repo's existing
// plain-script convention for the sibling hook tests.)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync, renameSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const HOOK_PATH = join(REPO_ROOT, ".claude", "hooks", "block-comment-edit-in-place.sh");

let failures = 0;

function runHook(stdinJson, env = {}) {
  return spawnSync("bash", [HOOK_PATH], {
    input: stdinJson,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, ...env },
  });
}

function check(name, condition, detail) {
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
  }
}

// --- Case 1: addCommentToJiraIssue with a commentId is denied ---
{
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__addCommentToJiraIssue",
    tool_input: { cloudId: "x", issueIdOrKey: "TARS-1450", commentBody: "updated", commentId: "1039214" },
  });
  const result = runHook(stdin);
  check("addCommentToJiraIssue with commentId: exit code is 2", result.status === 2, `got ${result.status}`);
  check("addCommentToJiraIssue with commentId: stderr is non-empty", result.stderr.trim().length > 0);
}

// --- Case 2: addCommentToJiraIssue with no commentId (a real create) is allowed ---
{
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__addCommentToJiraIssue",
    tool_input: { cloudId: "x", issueIdOrKey: "TARS-1450", commentBody: "fresh comment" },
  });
  const result = runHook(stdin);
  check("addCommentToJiraIssue without commentId: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

// --- Case 3: gh api PATCH on an existing issue comment is denied ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "gh api repos/fandango/webtarsthree/issues/comments/5735844223 -X PATCH -f body='updated'" },
  });
  const result = runHook(stdin);
  check("gh api PATCH issue comment: exit code is 2", result.status === 2, `got ${result.status}`);
}

// --- Case 4: gh issue comment --edit-last is denied ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "gh issue comment 439 --edit-last --body 'updated'" },
  });
  const result = runHook(stdin);
  check("gh issue comment --edit-last: exit code is 2", result.status === 2, `got ${result.status}`);
}

// --- Case 5: a fresh gh issue comment (no edit flags) is allowed ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "gh issue comment 439 --body 'fresh comment'" },
  });
  const result = runHook(stdin);
  check("fresh gh issue comment: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

// --- Case 6: unrelated Bash command is allowed without invoking the checker's edit logic ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  const result = runHook(stdin);
  check("unrelated Bash command: exit code is 0", result.status === 0, `got ${result.status}`);
}

// --- Case 7: unrelated MCP tool call is allowed ---
{
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__getJiraIssue",
    tool_input: { cloudId: "x", issueIdOrKey: "TARS-1450" },
  });
  const result = runHook(stdin);
  check("getJiraIssue: exit code is 0", result.status === 0, `got ${result.status}`);
}

// --- Case 8: simulated checker crash fails closed (exit 2), with a distinct reason ---
{
  const brokenCheckerPath = join(REPO_ROOT, "scripts", "__test_broken_edit_checker__.ts");
  writeFileSync(brokenCheckerPath, "throw new Error('simulated checker crash');\n");
  const realCheckerPath = join(REPO_ROOT, "scripts", "check-comment-edit-in-tool-input.ts");
  const backupPath = join(REPO_ROOT, "scripts", "__check-comment-edit-in-tool-input.ts.bak");
  try {
    renameSync(realCheckerPath, backupPath);
    try {
      renameSync(brokenCheckerPath, realCheckerPath);
      const stdin = JSON.stringify({
        tool_name: "mcp__atlassian__addCommentToJiraIssue",
        tool_input: { commentId: "123" },
      });
      const result = runHook(stdin);
      check("checker-failure: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}`);
      check(
        "checker-failure: stderr reason is distinguishable from the edit-detected reason",
        result.stderr.includes("could not verify"),
        result.stderr,
      );
    } finally {
      renameSync(realCheckerPath, brokenCheckerPath);
      renameSync(backupPath, realCheckerPath);
    }
  } finally {
    try {
      unlinkSync(brokenCheckerPath);
    } catch {
      // already cleaned up above
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll checks passed.");
}
