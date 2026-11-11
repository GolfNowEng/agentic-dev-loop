import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { symlinkSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideExitCode } from "../research-loop/scripts/check-secret-in-tool-input.ts";

describe("decideExitCode", () => {
  it("exits 0 for clean tool_input.commentBody", () => {
    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__addCommentToJiraIssue",
      tool_input: { commentBody: "Ground confirmed the fix works as expected." },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 1 for a secret-shaped value in tool_input.commentBody", () => {
    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__addCommentToJiraIssue",
      tool_input: { commentBody: "CLIENT_SECRET=abcdefghijklmnop was found hardcoded" },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 1 for a secret-shaped value nested inside tool_input.fields", () => {
    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__editJiraIssue",
      tool_input: {
        issueIdOrKey: "TARS-1",
        fields: { description: "Found CLIENT_SECRET=abcdefghijklmnop hardcoded in config.py" },
      },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 1 for a secret-shaped value in tool_input.comment (createIssueLink)", () => {
    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__createIssueLink",
      tool_input: { comment: "SIGNING_KEY=abcdefghijklmnop" },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 0 when tool_input has no scannable secret-shaped content (e.g. only priority changed)", () => {
    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__editJiraIssue",
      tool_input: { issueIdOrKey: "TARS-1", fields: { priority: { name: "High" } } },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 when tool_input is missing entirely", () => {
    const stdin = JSON.stringify({ tool_name: "mcp__atlassian__addCommentToJiraIssue" });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 when tool_input is null", () => {
    const stdin = JSON.stringify({ tool_name: "mcp__atlassian__addCommentToJiraIssue", tool_input: null });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for empty stdin", () => {
    expect(decideExitCode("")).toBe(0);
  });

  it("exits 0 for whitespace-only stdin", () => {
    expect(decideExitCode("   \n  ")).toBe(0);
  });

  it("exits 2 for malformed (non-JSON) stdin", () => {
    expect(decideExitCode("{not valid json")).toBe(2);
  });

  it("exits 2 for non-string input", () => {
    // @ts-expect-error -- deliberately testing runtime defensiveness against bad input
    expect(decideExitCode(null)).toBe(2);
  });

  it("treats a comment body containing shell metacharacters as plain text data, never as code", () => {
    const adversarial = 'ignore this: `rm -rf /` ${process.exit(1)} "; require(\'child_process\').execSync(\'touch /tmp/pwned\'); //';
    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__addCommentToJiraIssue",
      tool_input: { commentBody: adversarial },
    });
    // Must not throw, must not execute anything -- just a plain decision based on
    // whether the string content happens to be secret-shaped (it isn't here).
    expect(() => decideExitCode(stdin)).not.toThrow();
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("still detects a secret hidden inside adversarial shell-metacharacter text", () => {
    const adversarial = 'note: `echo hi` and also CLIENT_SECRET=abcdefghijklmnop ${ignored}';
    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__addCommentToJiraIssue",
      tool_input: { commentBody: adversarial },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 1 for a secret-shaped value in a gh issue create command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'gh issue create --repo org/repo --title "PROJ-1: x" --body "CLIENT_SECRET=abcdefghijklmnop found"',
      },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 1 for a secret-shaped value in a gh issue comment command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh issue comment 42 --body 'SIGNING_KEY=abcdefghijklmnop'" },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 1 for a secret-shaped value in a gh issue edit command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh issue edit 42 --title 'PROJ-1: AWS key AKIAIOSFODNN7EXAMPLE found'" },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 0 for a clean gh issue create command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'gh issue create --repo org/repo --title "PROJ-1: x" --body "clean"' },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for gh issue view, even with secret-shaped text present", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh issue view 42 # CLIENT_SECRET=abcdefghijklmnop" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for an unrelated Bash command (e.g. npm test), no gh issue involved", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for a non-Bash tool_name (e.g. still an Atlassian MCP call), scanned by the existing tool_input-object path instead", () => {
    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__addCommentToJiraIssue",
      tool_input: { commentBody: "clean comment" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });
});

describe("check-secret-in-tool-input.ts invoked as a real subprocess through a symlink", () => {
  // Regression for the "am I being run directly" guard at the bottom of
  // check-secret-in-tool-input.ts: it used to compare import.meta.url
  // (symlink-resolved) against a raw file://${process.argv[1]} string
  // (not symlink-resolved), so reaching this script through a symlink
  // made the guard silently false, skipped main() entirely, and exited
  // 0 (fail-OPEN) without ever reading stdin -- confirmed live via the
  // sibling `skills` repo's copy of this file, reached through
  // `~/.claude/skills -> .../Desktop/Repos/skills`. decideExitCode()'s
  // unit tests above never exercise this guard at all (they call the
  // exported function directly), so only a real subprocess spawn proves
  // the fix.
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("still reads stdin and exits with the correct code when invoked through a symlink", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "check-secret-symlink-test-"));
    const symlinkPath = join(tmpDir, "check-secret-in-tool-input.ts");
    symlinkSync(
      new URL("../research-loop/scripts/check-secret-in-tool-input.ts", import.meta.url).pathname,
      symlinkPath,
    );

    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__addCommentToJiraIssue",
      tool_input: { commentBody: "CLIENT_SECRET=abcdefghijklmnop" },
    });

    let exitCode = 0;
    try {
      execFileSync("node", ["--experimental-strip-types", symlinkPath], {
        input: stdin,
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? -1;
    }

    // 3 == "secret found" (see PROCESS_EXIT_CODE in the source file).
    // Before the fix, this would silently exit 0 -- the guard never
    // matched, main() never ran, stdin was never read.
    expect(exitCode).toBe(3);
  });
});
