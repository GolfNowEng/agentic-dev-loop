// End-to-end test of .claude/hooks/block-secret-comments.sh, driven via
// real piped stdin JSON the same shape Claude Code sends a PreToolUse
// hook. Run standalone with:
//   node test/hooks/block-secret-comments.test.mjs
// (not wired into `npm test`/vitest -- this drives an actual child
// process/bash script, not an in-process unit, matching this repo's
// existing plain-script convention for anything outside vitest's scope.)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync, chmodSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const HOOK_PATH = join(REPO_ROOT, ".claude", "hooks", "block-secret-comments.sh");

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

// --- Case 1: secret-shaped input is denied ---
{
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__addCommentToJiraIssue",
    tool_input: { commentBody: "CLIENT_SECRET=abcdefghijklmnop was found hardcoded" },
  });
  const result = runHook(stdin);
  check("secret-shaped input: exit code is 2", result.status === 2, `got ${result.status}`);
  check("secret-shaped input: stderr is non-empty", result.stderr.trim().length > 0);
  check(
    "secret-shaped input: stderr does not contain the actual secret value",
    !result.stderr.includes("abcdefghijklmnop"),
    result.stderr,
  );
}

// --- Case 2: clean input is allowed ---
{
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__addCommentToJiraIssue",
    tool_input: { commentBody: "Ground confirmed the fix works as expected." },
  });
  const result = runHook(stdin);
  check("clean input: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

// --- Case 3: simulated checker failure fails closed (exit 2), with a distinct reason ---
{
  const brokenCheckerPath = join(REPO_ROOT, "scripts", "__test_broken_checker__.ts");
  writeFileSync(brokenCheckerPath, "throw new Error('simulated checker crash');\n");
  try {
    // Point CLAUDE_PROJECT_DIR at a throwaway dir whose scripts/ has only
    // the broken checker at the expected relative path, by symlinking the
    // real repo layout is overkill -- instead, temporarily swap the real
    // checker aside and put the broken one in its place, then restore.
    const realCheckerPath = join(REPO_ROOT, "scripts", "check-secret-in-tool-input.ts");
    const backupPath = join(REPO_ROOT, "scripts", "__check-secret-in-tool-input.ts.bak");
    const { renameSync } = await import("node:fs");
    renameSync(realCheckerPath, backupPath);
    try {
      renameSync(brokenCheckerPath, realCheckerPath);
      const stdin = JSON.stringify({
        tool_name: "mcp__atlassian__addCommentToJiraIssue",
        tool_input: { commentBody: "irrelevant" },
      });
      const result = runHook(stdin);
      check("checker-failure: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}`);
      check(
        "checker-failure: stderr reason is distinguishable from the secret-found reason",
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
