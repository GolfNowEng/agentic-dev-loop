import { describe, it, expect } from "vitest";
import { decideExitCode } from "../scripts/check-secret-in-tool-input.ts";

describe("decideExitCode", () => {
  it("exits 0 for a clean gh pr create command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --title "TARS-1: fix" --body "## Changes\n- clean"',
      },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 1 for a secret-shaped value in a gh pr create command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --title "TARS-1" --body "found CLIENT_SECRET=abcdefghijklmnop hardcoded"',
      },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 1 for a secret-shaped value in a gh pr edit command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh pr edit 123 --body 'SIGNING_KEY=abcdefghijklmnop'" },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 0 for a non-gh command, even if it contains secret-shaped text", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "echo CLIENT_SECRET=abcdefghijklmnop >> notes.txt" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for gh pr view, even with secret-shaped text present", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh pr view 42 # CLIENT_SECRET=abcdefghijklmnop" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for gh issue create, not a pr command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh issue create --title CLIENT_SECRET=abcdefghijklmnop" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 when tool_name is not Bash", () => {
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { command: "gh pr create --body CLIENT_SECRET=abcdefghijklmnop" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 when tool_input.command is missing", () => {
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: {} });
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

  it("treats a command containing shell metacharacters as plain text data, never as code", () => {
    const adversarial = 'gh pr create --body "`rm -rf /` ${process.exit(1)} \\"; require(\'child_process\').execSync(\'touch /tmp/pwned\'); //"';
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: adversarial } });
    expect(() => decideExitCode(stdin)).not.toThrow();
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("still detects a secret hidden inside adversarial shell-metacharacter text", () => {
    const adversarial = 'gh pr create --body "`echo hi` and CLIENT_SECRET=abcdefghijklmnop ${ignored}"';
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: adversarial } });
    expect(decideExitCode(stdin)).toBe(1);
  });
});
