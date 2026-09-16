// End-to-end test of .claude/hooks/block-github-secret-writes.sh, driven
// via real piped stdin JSON the same shape Claude Code sends a PreToolUse
// hook for a Bash tool call. Run standalone with:
//   node test/hooks/block-github-secret-writes.test.mjs
// (not wired into npm test/vitest -- this drives an actual child
// process/bash script, not an in-process unit, matching this repo's
// existing plain-script convention for the sibling Atlassian hook test.)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync, renameSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const HOOK_PATH = join(REPO_ROOT, ".claude", "hooks", "block-github-secret-writes.sh");

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

// --- Case 1: secret-shaped gh issue create body is denied ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: 'gh issue create --repo org/repo --title "PROJ-1: x" --body "CLIENT_SECRET=abcdefghijklmnop found hardcoded"' },
  });
  const result = runHook(stdin);
  check("secret-shaped gh issue create: exit code is 2", result.status === 2, `got ${result.status}`);
  check("secret-shaped gh issue create: stderr is non-empty", result.stderr.trim().length > 0);
  check(
    "secret-shaped gh issue create: stderr does not contain the actual secret value",
    !result.stderr.includes("abcdefghijklmnop"),
    result.stderr,
  );
}

// --- Case 2: secret-shaped gh issue comment body is denied ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "gh issue comment 42 --body 'SIGNING_KEY=abcdefghijklmnop'" },
  });
  const result = runHook(stdin);
  check("secret-shaped gh issue comment: exit code is 2", result.status === 2, `got ${result.status}`);
}

// --- Case 3: clean gh issue create body is allowed ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: 'gh issue create --repo org/repo --title "PROJ-1: x" --body "clean"' },
  });
  const result = runHook(stdin);
  check("clean gh issue create: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

// --- Case 4: unrelated Bash command (e.g. npm test) is allowed without invoking the checker at all ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  const result = runHook(stdin);
  check("unrelated Bash command: exit code is 0", result.status === 0, `got ${result.status}`);
}

// --- Case 5: gh issue view (not create/edit/comment) is allowed even with secret-shaped text present ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "gh issue view 42 # CLIENT_SECRET=abcdefghijklmnop" },
  });
  const result = runHook(stdin);
  check("gh issue view: exit code is 0", result.status === 0, `got ${result.status}`);
}

// --- Case 6: gh pr create (not gh issue) is allowed by this hook -- it's not this hook's surface ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: 'gh pr create --title "x" --body "CLIENT_SECRET=abcdefghijklmnop"' },
  });
  const result = runHook(stdin);
  check("gh pr create (not gh issue): exit code is 0 -- out of this hook's scope", result.status === 0, `got ${result.status}`);
}

// --- Case 7: simulated checker crash fails closed (exit 2), with a distinct reason ---
{
  const brokenCheckerPath = join(REPO_ROOT, "scripts", "__test_broken_checker__.ts");
  writeFileSync(brokenCheckerPath, "throw new Error('simulated checker crash');\n");
  const realCheckerPath = join(REPO_ROOT, "scripts", "check-secret-in-tool-input.ts");
  const backupPath = join(REPO_ROOT, "scripts", "__check-secret-in-tool-input.ts.bak");
  try {
    renameSync(realCheckerPath, backupPath);
    try {
      renameSync(brokenCheckerPath, realCheckerPath);
      const stdin = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh issue create --body irrelevant" },
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

// --- Case 8: jq missing from PATH fails closed (exit 2) with a message distinguishable from the malformed-JSON case ---
{
  const noJqDir = mkdtempSync(join(tmpdir(), "no-jq-path-"));
  const binsToLink = {
    bash: "/bin/bash",
    cat: "/bin/cat",
    grep: "/usr/bin/grep",
    node: process.execPath,
  };
  try {
    for (const [name, target] of Object.entries(binsToLink)) {
      try {
        symlinkSync(target, join(noJqDir, name));
      } catch {
        // best-effort
      }
    }
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'gh issue create --title "PROJ-1" --body "irrelevant"' },
    });
    const result = runHook(stdin, { PATH: noJqDir });
    check(
      "jq missing from PATH: exit code is 2 (fail closed)",
      result.status === 2,
      `got ${result.status}, stderr: ${result.stderr}`,
    );
    check(
      "jq missing from PATH: stderr mentions jq/not found, not malformed JSON",
      /jq/i.test(result.stderr) && /not found/i.test(result.stderr) && !/malformed JSON/i.test(result.stderr),
      result.stderr,
    );
  } finally {
    rmSync(noJqDir, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll checks passed.");
}
