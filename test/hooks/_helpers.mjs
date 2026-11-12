// Shared helpers for the end-to-end hook tests in this directory. Not a
// test file itself (npm run test:hooks only runs *.test.mjs).
//
// Every hook is driven the way Claude Code drives it: a real `bash` child
// process, the PreToolUse JSON on stdin, verdict read from the exit code
// (0 allow, 2 deny) and the reason from stderr.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");

let failures = 0;

export function hookPath(name) {
  return join(REPO_ROOT, ".claude", "hooks", name);
}

/**
 * Runs a hook script with CLAUDE_PROJECT_DIR = the repo root (both roles
 * spawn from there). `cwd` defaults to the repo root too; pass another one
 * to run the hook the way it runs after a skill `cd`s into its worktree.
 */
export function runHook(name, stdinJson, { env = {}, path, cwd = REPO_ROOT } = {}) {
  const merged = { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, ...env };
  // An override of `undefined` means "unset this variable".
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  return spawnSync("bash", [path ?? hookPath(name)], {
    input: stdinJson,
    encoding: "utf8",
    cwd,
    env: merged,
  });
}

/** Runs `fn(dir)` with a throwaway directory outside the repo (a stand-in for a worktree cwd). */
export function withOutsideCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hook-cwd-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copies one hook into a throwaway repo layout (<tmp>/.claude/hooks/<name>)
 * so the checker it resolves next to itself (<tmp>/scripts/<checker>) can
 * be missing or broken without touching the real scripts/ directory.
 * `checkers` maps a checker file name to its source text.
 */
export function withTempLayout(name, checkers, fn) {
  const root = mkdtempSync(join(tmpdir(), "hook-layout-"));
  try {
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    const copied = join(root, ".claude", "hooks", name);
    copyFileSync(hookPath(name), copied);
    chmodSync(copied, 0o755);
    const entries = Object.entries(checkers);
    if (entries.length > 0) mkdirSync(join(root, "scripts"), { recursive: true });
    for (const [file, source] of entries) writeFileSync(join(root, "scripts", file), source);
    return fn(copied, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A PATH holding bash/cat/grep/node but not jq. */
export function withNoJqPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), "no-jq-path-"));
  const bins = { bash: "/bin/bash", cat: "/bin/cat", grep: "/usr/bin/grep", dirname: "/usr/bin/dirname", node: process.execPath };
  try {
    for (const [binName, target] of Object.entries(bins)) {
      try {
        symlinkSync(target, join(dir, binName));
      } catch {
        // best-effort: skip a binary this host doesn't have at that path
      }
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function check(name, condition, detail) {
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
  }
}

export function finish() {
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

export const BROKEN_CHECKER = "throw new Error('simulated checker crash');\n";
