import { describe, it, expect } from "vitest";
import { decideExitCode } from "../scripts/check-secret-in-tool-input.ts";

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
