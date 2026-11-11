// reset-cli.ts is the untested-by-unit composition root; these cases drive
// it as a subprocess under --dry-run (no clients constructed, nothing
// deleted) to pin the one behavior that diverged between dev-loop and
// research-loop: --close-remote must recover the ticket's PR URL from
// runs.jsonl BEFORE local reset would trim it (dev-loop), and must be a
// harmless "no PR" no-op for a research-loop runs.jsonl, whose lines
// always carry pr: null.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = promisify(execFile);
const CLI = resolve(import.meta.dirname, "../../src/core/reset-cli.ts");

function line(ticket: string, outcome: string, pr: string | null): string {
  return JSON.stringify({ ticket, outcome, pr, ended: "2026-11-10T00:00:00Z" });
}

describe("reset-cli --close-remote --dry-run", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reset-cli-test-"));
    await mkdir(join(dir, "runs"));
    // Unloadable config: reset-cli falls back to slug = project name and
    // never needs credentials under --dry-run.
    await writeFile(join(dir, "pipeline.proj.config.json"), "placeholder, not json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function dryRun(): Promise<string> {
    const { stdout } = await run(
      process.execPath,
      [CLI, "--project", "proj", "--ticket", "TARS-1", "--dry-run", "--close-remote"],
      { cwd: dir },
    );
    return stdout;
  }

  it("dev role: previews closing the ticket's open PR recovered from runs.jsonl", async () => {
    await writeFile(
      join(dir, "runs", "proj.jsonl"),
      line("TARS-1", "landed", "https://github.com/o/r/pull/7") + "\n",
    );
    const out = await dryRun();
    expect(out).toContain("- close Jira ticket TARS-1");
    expect(out).toContain("- close mirror GitHub Issue for TARS-1");
    expect(out).toContain("- close PR https://github.com/o/r/pull/7");
    expect(out).toContain("--dry-run: nothing deleted or closed.");
  });

  it("research role: a runs.jsonl with pr: null previews no PR to close", async () => {
    await writeFile(join(dir, "runs", "proj.jsonl"), line("TARS-1", "bounced", null) + "\n");
    const out = await dryRun();
    expect(out).toContain("- close Jira ticket TARS-1");
    expect(out).toContain("- close mirror GitHub Issue for TARS-1");
    expect(out).toContain("no open PR found locally for this ticket -- nothing to close");
    expect(out).not.toContain("- close PR ");
  });

  it("dry-run leaves runs.jsonl untouched", async () => {
    const content = line("TARS-1", "landed", "https://github.com/o/r/pull/7") + "\n";
    await writeFile(join(dir, "runs", "proj.jsonl"), content);
    await dryRun();
    expect(await readFile(join(dir, "runs", "proj.jsonl"), "utf8")).toBe(content);
  });

  it("refuses --close-remote without --ticket", async () => {
    await expect(
      run(process.execPath, [CLI, "--project", "proj", "--close-remote", "--dry-run"], { cwd: dir }),
    ).rejects.toMatchObject({ code: 1 });
  });
});
