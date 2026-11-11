// reset-cli.ts is the composition root; these cases drive it as a
// subprocess against a temp state root (--root). The cwd holds an
// unloadable pipeline.proj.config.json, so reset-cli falls back to
// slug = project name with no worktree scan and never needs credentials.
// --close-remote is only ever run with --dry-run here (no clients built).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processStartTime } from "../../src/core/session.ts";

const run = promisify(execFile);
const CLI = resolve(import.meta.dirname, "../../src/core/reset-cli.ts");

function v2rec(ticket: string, role: "research" | "dev", pr: string | null, outcome = "landed"): string {
  return JSON.stringify({
    ticket, session: "dev-1", loop_version: "2.0.0", started: "2026-11-10T00:00:00.000Z", ended: "2026-11-10T00:01:00.000Z",
    outcome,
    phases: [{
      role, skill: role === "dev" ? "ticket-to-pr" : "ticket-refine", skill_version: "s", model: "m",
      started: "2026-11-10T00:00:00.000Z", ended: "2026-11-10T00:01:00.000Z", outcome, phase_reached: "pr",
      cost_usd: 1, tokens: { in: 1, out: 1 }, failure_category: null, detail: "d", pr, run_dir: "d",
    }],
  });
}
const v1line = (ticket: string, outcome: string, pr: string | null) => JSON.stringify({ ticket, outcome, pr, ended: "2026-11-01T00:00:00Z" });

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}
const exists = (p: string) => stat(p).then(() => true, () => false);

describe("reset-cli", () => {
  let dir: string;
  let root: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reset-cli-test-"));
    root = join(dir, "state");
    await mkdir(root);
    await writeFile(join(dir, "pipeline.proj.config.json"), "placeholder, not json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cli = (...args: string[]) => run(process.execPath, [CLI, "--root", root, "--project", "proj", ...args], { cwd: dir });

  it("--close-remote --dry-run previews the PR recorded in the v2 log", async () => {
    await put(root, "runs/v2/proj.jsonl", v2rec("TARS-1", "dev", "https://github.com/o/r/pull/7") + "\n");
    const { stdout } = await cli("--ticket", "TARS-1", "--dry-run", "--close-remote");
    expect(stdout).toContain("- close Jira ticket TARS-1");
    expect(stdout).toContain("- close mirror GitHub Issue for TARS-1");
    expect(stdout).toContain("- close PR https://github.com/o/r/pull/7");
    expect(stdout).toContain("--dry-run: nothing deleted or closed.");
  });

  it("--close-remote --dry-run falls back to a PR in the v1 dev log (pre-cutover runs/<slug>.jsonl)", async () => {
    await put(root, "runs/proj.jsonl", v1line("TARS-1", "bounced", "https://github.com/o/r/pull/8") + "\n");
    const { stdout } = await cli("--ticket", "TARS-1", "--dry-run", "--close-remote");
    expect(stdout).toContain("- close PR https://github.com/o/r/pull/8");
  });

  it("--close-remote --dry-run with only research records previews no PR", async () => {
    await put(root, "runs/v2/proj.jsonl", v2rec("TARS-1", "research", null) + "\n");
    const { stdout } = await cli("--ticket", "TARS-1", "--dry-run", "--close-remote");
    expect(stdout).toContain("no open PR found locally for this ticket -- nothing to close");
    expect(stdout).not.toContain("- close PR ");
  });

  it("--dry-run prints the plan (role all by default) and changes nothing", async () => {
    const log = v2rec("TARS-1", "dev", null) + "\n";
    await put(root, "runs/v2/proj.jsonl", log);
    await put(root, ".pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z/usage.json", "{}");
    const { stdout } = await cli("--ticket", "TARS-1", "--dry-run");
    expect(stdout).toContain("role: all");
    expect(stdout).toContain("archive 1 record(s)");
    expect(await readFile(join(root, "runs/v2/proj.jsonl"), "utf8")).toBe(log);
    expect(await exists(join(root, ".pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z/usage.json"))).toBe(true);
    expect(await exists(join(root, "runs/v2/proj.reset-archive.jsonl"))).toBe(false);
  });

  it("--role research deletes only research-* dirs and never touches v1 folders", async () => {
    await put(root, "runs/v2/proj.jsonl", [v2rec("TARS-1", "research", null), v2rec("TARS-1", "dev", null)].join("\n") + "\n");
    await put(root, ".pipeline/v2/proj/dev-1/TARS-1/research-20261110T000000Z/usage.json", "{}");
    await put(root, ".pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z/usage.json", "{}");
    await put(root, "runs/v1/dev/proj.jsonl", v1line("TARS-1", "landed", null) + "\n");
    await put(root, ".pipeline/v1/research/proj/runs/TARS-1-x/verdict.json", "{}");
    await put(root, "runs/proj.jsonl", v1line("TARS-1", "landed", null) + "\n");
    await put(root, ".pipeline/proj/runs/TARS-1-x/verdict.json", "{}");
    await put(root, "research-loop/runs/proj.jsonl", v1line("TARS-1", "landed", null) + "\n");

    await cli("--ticket", "TARS-1", "--role", "research");

    expect(await readdir(join(root, ".pipeline/v2/proj/dev-1/TARS-1"))).toEqual(["dev-20261110T000000Z"]);
    expect((await readFile(join(root, "runs/v2/proj.jsonl"), "utf8")).trim()).toBe(v2rec("TARS-1", "dev", null));
    expect(await readFile(join(root, "runs/v1/dev/proj.jsonl"), "utf8")).toBe(v1line("TARS-1", "landed", null) + "\n");
    expect(await readFile(join(root, "runs/proj.jsonl"), "utf8")).toBe(v1line("TARS-1", "landed", null) + "\n");
    expect(await readFile(join(root, "research-loop/runs/proj.jsonl"), "utf8")).toBe(v1line("TARS-1", "landed", null) + "\n");
    expect(await exists(join(root, ".pipeline/v1/research/proj/runs/TARS-1-x/verdict.json"))).toBe(true);
    expect(await exists(join(root, ".pipeline/proj/runs/TARS-1-x/verdict.json"))).toBe(true);
  });

  it("a live worker lock (this test process) blocks a real reset unless --ignore-live-worker; dry-run only warns", async () => {
    const log = v2rec("TARS-1", "dev", null) + "\n";
    await put(root, "runs/v2/proj.jsonl", log);
    await put(root, ".pipeline/v2/proj/sessions/dev-1.lock", JSON.stringify({ pid: process.pid, started: processStartTime(process.pid), inFlight: null }));

    const dry = await cli("--ticket", "TARS-1", "--dry-run");
    expect(dry.stdout).toMatch(/WARNING: session lock/);

    await expect(cli("--ticket", "TARS-1")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("--ignore-live-worker") });
    expect(await readFile(join(root, "runs/v2/proj.jsonl"), "utf8")).toBe(log);

    await cli("--ticket", "TARS-1", "--ignore-live-worker");
    expect(await readFile(join(root, "runs/v2/proj.reset-archive.jsonl"), "utf8")).toBe(log);
  });

  it("--include-cross-role archives a record whose other role landed; without it the plan shows REFUSED", async () => {
    const both = JSON.stringify({
      ...JSON.parse(v2rec("TARS-1", "research", null)),
      phases: [JSON.parse(v2rec("TARS-1", "research", null)).phases[0], JSON.parse(v2rec("TARS-1", "dev", "https://github.com/o/r/pull/9")).phases[0]],
    });
    await put(root, "runs/v2/proj.jsonl", both + "\n");
    const dry = await cli("--ticket", "TARS-1", "--role", "research", "--dry-run");
    expect(dry.stdout).toContain("REFUSED (other role landed: dev https://github.com/o/r/pull/9)");
    await cli("--ticket", "TARS-1", "--role", "research");
    expect(await readFile(join(root, "runs/v2/proj.jsonl"), "utf8")).toBe(both + "\n");
    await cli("--ticket", "TARS-1", "--role", "research", "--include-cross-role");
    expect(await readFile(join(root, "runs/v2/proj.reset-archive.jsonl"), "utf8")).toBe(both + "\n");
  });

  it("rejects an unknown --role", async () => {
    await expect(cli("--ticket", "TARS-1", "--role", "qa", "--dry-run")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--role must be research, dev or all"),
    });
  });

  it("refuses --close-remote without --ticket", async () => {
    await expect(cli("--close-remote", "--dry-run")).rejects.toMatchObject({ code: 1 });
  });

  it("a whole-project reset requires --yes", async () => {
    await put(root, "runs/v2/proj.jsonl", v2rec("TARS-1", "dev", null) + "\n");
    await expect(cli()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("--yes") });
    expect(await exists(join(root, "runs/v2/proj.jsonl"))).toBe(true);
  });
});

describe("reset-cli config resolution", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reset-cli-root-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("a cwd with no config of its own resolves --project against the repo root's configs", async () => {
    const { stdout } = await run(process.execPath, [CLI, "--root", root, "--project", "webtarsthree", "--ticket", "TARS-1", "--dry-run"], { cwd: root });
    expect(stdout).toContain("--dry-run: nothing deleted or closed.");
    expect(stdout).toContain(join(root, "runs/v2/webtarsthree.jsonl"));
  });

  it("still fails, listing the repo root's projects, for an unknown project", async () => {
    await expect(
      run(process.execPath, [CLI, "--root", root, "--project", "nope", "--ticket", "TARS-1", "--dry-run"], { cwd: root }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/Unknown project "nope".*webtarsthree/) });
  });
});
