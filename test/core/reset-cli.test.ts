// reset-cli.ts is the composition root; these cases drive it as a
// subprocess against a temp state root (--root). The cwd holds an
// unloadable pipeline.proj.config.json, so reset-cli falls back to
// slug = project name with no worktree scan and never needs credentials.
// The child env carries no JIRA_* / ATLASSIAN_* vars, so no real client is
// ever built: Jira/GitHub rows read "needs you: no credentials".
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
/** process.env without credentials, so the child can never reach a real service. */
const NO_CREDS_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(JIRA_|ATLASSIAN_|GH_|GITHUB_)/.test(k) && k !== "DEVLOOP_ENV_FILE"),
);

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

  /** A loadable config whose target repo is an empty local git repo (no remote). */
  const validConfig = async (): Promise<void> => {
    const repo = join(dir, "target");
    await mkdir(repo);
    await run("git", ["init", "-q", repo]);
    const cfg = JSON.parse(await readFile(resolve(import.meta.dirname, "../../pipeline.eval.config.json"), "utf8"));
    cfg.targetRepo.url = "git@github.com:o/proj.git";
    cfg.targetRepo.path = repo;
    await writeFile(join(dir, "pipeline.proj.config.json"), JSON.stringify(cfg));
  };
  const cli = (...args: string[]) => run(process.execPath, [CLI, `--root=${root}`, "--project=proj", ...args], { cwd: dir, env: NO_CREDS_ENV });
  /** Like cli, but resolves with the exit code instead of rejecting on non-zero. */
  const cliCode = (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    cli(...args).then(
      (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
    );

  it("refuses the old --name value form, naming the replacement", async () => {
    await expect(cli("--ticket", "TARS-1", "--dry-run")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("use --ticket=TARS-1"),
    });
  });

  it("--close-remote --dry-run previews the PR recorded in the v2 log", async () => {
    await put(root, "runs/v2/proj.jsonl", v2rec("TARS-1", "dev", "https://github.com/o/r/pull/7") + "\n");
    const { stdout } = await cli("--ticket=TARS-1", "--dry-run", "--close-remote");
    expect(stdout).toMatch(/jira\s+close ticket\s+-\s+needs you: no project config/);
    expect(stdout).toMatch(/github\s+close mirror Issue\s+-\s+needs you: no project config/);
    expect(stdout).toMatch(/github\s+close PR\s+https:\/\/github.com\/o\/r\/pull\/7\s+needs you: no project config/);
    expect(stdout).not.toMatch(/jira\s+(status|label|loop comments)/);
    expect(stdout).toContain("[reset] --dry-run: nothing changed.");
  });

  it("--close-remote --dry-run falls back to a PR in the v1 dev log (pre-cutover runs/<slug>.jsonl)", async () => {
    await put(root, "runs/proj.jsonl", v1line("TARS-1", "bounced", "https://github.com/o/r/pull/8") + "\n");
    const { stdout } = await cli("--ticket=TARS-1", "--dry-run", "--close-remote");
    expect(stdout).toMatch(/github\s+close PR\s+https:\/\/github.com\/o\/r\/pull\/8/);
  });

  it("--close-remote --dry-run with only research records previews no PR", async () => {
    await put(root, "runs/v2/proj.jsonl", v2rec("TARS-1", "research", null) + "\n");
    const { stdout } = await cli("--ticket=TARS-1", "--dry-run", "--close-remote");
    expect(stdout).toMatch(/github\s+close PR\s+none\s+-/);
  });

  it("--dry-run prints the plan (role all by default) and changes nothing", async () => {
    const log = v2rec("TARS-1", "dev", null) + "\n";
    await put(root, "runs/v2/proj.jsonl", log);
    await put(root, ".pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z/usage.json", "{}");
    const { stdout } = await cli("--ticket=TARS-1", "--dry-run");
    expect(stdout).toContain("Reset TARS-1 (role: all)");
    expect(stdout).toMatch(/local\s+run records\s+1 records in runs\/v2\/proj\s+archive 1/);
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

    expect((await cliCode("--ticket=TARS-1", "--role=research", "--yes")).code).toBe(1); // jira: no credentials

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

    const dry = await cli("--ticket=TARS-1", "--dry-run");
    expect(dry.stdout).toMatch(/local\s+live worker\s+dev-1.lock \(holder alive\)\s+needs you: a live worker holds dev-1.lock/);

    const refused = await cliCode("--ticket=TARS-1", "--yes");
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("[reset] refusing: a live worker holds");
    expect(refused.stdout).toContain("--ignore-live-worker");
    expect(await readFile(join(root, "runs/v2/proj.jsonl"), "utf8")).toBe(log);

    expect((await cliCode("--ticket=TARS-1", "--ignore-live-worker", "--yes")).code).toBe(1); // jira: no credentials
    expect(await readFile(join(root, "runs/v2/proj.reset-archive.jsonl"), "utf8")).toBe(log);
  });

  it("--include-cross-role archives a record whose other role landed; without it the plan shows REFUSED", async () => {
    const both = JSON.stringify({
      ...JSON.parse(v2rec("TARS-1", "research", null)),
      phases: [JSON.parse(v2rec("TARS-1", "research", null)).phases[0], JSON.parse(v2rec("TARS-1", "dev", "https://github.com/o/r/pull/9")).phases[0]],
    });
    await put(root, "runs/v2/proj.jsonl", both + "\n");
    const dry = await cli("--ticket=TARS-1", "--role=research", "--dry-run");
    // Detail lines wrap under the Step column; join them back to check the whole text is shown.
    const details = dry.stdout.split("\n").filter((l) => /^ +(↳ | {2})\S/.test(l)).map((l) => l.trim().replace(/^↳ /, ""));
    expect(details.join(" ")).toContain("kept: TARS-1 record (other role landed: dev https://github.com/o/r/pull/9)");
    await cliCode("--ticket=TARS-1", "--role=research", "--yes");
    expect(await readFile(join(root, "runs/v2/proj.jsonl"), "utf8")).toBe(both + "\n");
    await cliCode("--ticket=TARS-1", "--role=research", "--include-cross-role", "--yes");
    expect(await readFile(join(root, "runs/v2/proj.reset-archive.jsonl"), "utf8")).toBe(both + "\n");
  });

  it("rejects an unknown --role", async () => {
    await expect(cli("--ticket=TARS-1", "--role=qa", "--dry-run")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--role must be research, dev or all"),
    });
  });

  it("refuses --close-remote without --ticket", async () => {
    await expect(cli("--close-remote", "--dry-run")).rejects.toMatchObject({ code: 1 });
  });

  it("--ticket --dry-run prints the table with jira rows needs you: no credentials", async () => {
    await validConfig();
    await put(root, "runs/v2/proj.jsonl", v2rec("TARS-1", "dev", null) + "\n");
    const r = await cliCode("--ticket=TARS-1", "--dry-run");
    expect(r.code).toBe(0);
    for (const step of ["status", "label", "loop comments", "follow-up tickets"]) {
      expect(r.stdout).toMatch(new RegExp(`jira\\s+${step}\\s+-\\s+needs you: no credentials`));
    }
    expect(r.stdout).toMatch(/github\s+mirror Issue\s+-\s+needs you: no credentials/);
    expect(r.stdout).not.toContain("Proceed?");
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe("[reset] --dry-run: nothing changed.");
    expect(await exists(join(root, "runs/v2/proj.reset-archive.jsonl"))).toBe(false);
  });

  it("--ticket without --yes and no TTY exits 1 and changes nothing", async () => {
    const log = v2rec("TARS-1", "dev", null) + "\n";
    await put(root, "runs/v2/proj.jsonl", log);
    await put(root, ".pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z/usage.json", "{}");
    const r = await cliCode("--ticket=TARS-1");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Reset TARS-1 (role: all)");
    expect(r.stdout).toContain("[reset] no terminal to ask on: rerun with --yes after reviewing the table above.");
    expect(await readFile(join(root, "runs/v2/proj.jsonl"), "utf8")).toBe(log);
    expect(await exists(join(root, ".pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z/usage.json"))).toBe(true);
  });

  it("--ticket --yes archives the record and exits 1 because jira needs you", async () => {
    const log = v2rec("TARS-1", "dev", null) + "\n";
    await put(root, "runs/v2/proj.jsonl", log);
    await put(root, ".pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z/usage.json", "{}");
    const r = await cliCode("--ticket=TARS-1", "--yes");
    expect(r.code).toBe(1);
    expect(await readFile(join(root, "runs/v2/proj.reset-archive.jsonl"), "utf8")).toBe(log);
    expect(await exists(join(root, ".pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z"))).toBe(false);
    expect(r.stdout).toContain("Ran");
    expect(r.stdout).toContain("After reset");
    expect(r.stdout).toMatch(/local\s+run records\s+1 records in runs\/v2\/proj\s+done/);
    // The cwd's config is unloadable: git, Jira and GitHub rows all need a config.
    expect(r.stdout).toContain("[reset] TARS-1 is not at zero: 8 step(s) need you:");
    expect(r.stdout).toContain("  - git worktrees: no project config");
    expect(r.stdout).toContain("  - jira status: no project config");
    expect(r.stdout).toContain("  - github mirror Issue: no project config");
  });

  it("--sandbox=nope exits 1 naming the valid adapters", async () => {
    const r = await cliCode("--ticket=TARS-1", "--dry-run", "--sandbox=nope");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown sandbox adapter "nope"; valid: none, sbx');
    expect(r.stdout).not.toContain("Reset TARS-1");
    const noTicket = await cliCode("--dry-run", "--sandbox=sbx");
    expect(noTicket.code).toBe(1);
    expect(noTicket.stderr).toContain("--sandbox requires --ticket");
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
    const { stdout } = await run(process.execPath, [CLI, `--root=${root}`, "--project=webtarsthree", "--ticket=TARS-1", "--dry-run"], { cwd: root, env: NO_CREDS_ENV });
    expect(stdout).toContain("(slug: webtarsthree), ticket: TARS-1");
    expect(stdout).toContain("[reset] --dry-run: nothing changed.");
  });

  it("still fails, listing the repo root's projects, for an unknown project", async () => {
    await expect(
      run(process.execPath, [CLI, `--root=${root}`, "--project=nope", "--ticket=TARS-1", "--dry-run"], { cwd: root, env: NO_CREDS_ENV }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/Unknown project "nope".*webtarsthree/) });
  });
});
