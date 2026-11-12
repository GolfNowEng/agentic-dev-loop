// scripts/stats.mjs driven as a subprocess against a temp state root
// (--root). v2 by default (per role, counted from phase entries); --v1
// reports the v1 dev and v1 research logs separately. It never writes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = promisify(execFile);
const SCRIPT = resolve(import.meta.dirname, "../../scripts/stats.mjs");

const now = new Date();
const recent = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
const OLD = "2020-01-01T00:00:00.000Z";

function phase(role: "research" | "dev", outcome: string, cost: number, started = recent(30)) {
  return {
    role, skill: role === "dev" ? "ticket-to-pr" : "ticket-refine", skill_version: "s", model: "sonnet",
    started, ended: started, outcome, phase_reached: "pr", cost_usd: cost, tokens: { in: 1, out: 1 },
    failure_category: outcome === "landed" ? null : "agent_error", detail: "d", pr: null, run_dir: "d",
  };
}
function rec(ticket: string, outcome: string, phases: object[], extra: object = {}) {
  return { ticket, session: "dev-1", loop_version: "2.0.0", started: recent(30), ended: recent(20), outcome, phases, ...extra };
}
const jsonl = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string): Promise<void> {
    for (const name of (await readdir(d)).sort()) {
      const p = join(d, name);
      if ((await stat(p)).isDirectory()) {
        out[`${p}/`] = "";
        await walk(p);
      } else out[p] = await readFile(p, "utf8");
    }
  }
  await walk(dir);
  return out;
}

describe("scripts/stats.mjs", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stats-test-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function stats(...args: string[]): Promise<string> {
    const { stdout } = await run(process.execPath, [SCRIPT, `--root=${root}`, "--project=proj", ...args]);
    return stdout;
  }

  it("refuses the old --name value form, naming the replacement", async () => {
    await expect(run(process.execPath, [SCRIPT, `--root=${root}`, "--days", "3"])).rejects.toMatchObject({
      stderr: expect.stringContaining("use --days=3"),
    });
  });

  async function fixtures(): Promise<void> {
    await mkdir(join(root, "runs/v2"), { recursive: true });
    await writeFile(
      join(root, "runs/v2/proj.jsonl"),
      jsonl([
        rec("TARS-1", "landed", [phase("research", "landed", 2), phase("dev", "landed", 3)]),
        rec("TARS-2", "bounced", [phase("research", "bounced", 1.5)]),
        rec("TARS-3", "error", [phase("dev", "error", 0.25)]),
        rec("TARS-4", "killed", [phase("dev", "killed", 0.25)]),
        rec("TARS-5", "handoff-done", []),
        rec("TARS-6", "landed", [phase("dev", "landed", 100, OLD)]),
      ]) + "{ truncated\n",
    );
    await mkdir(join(root, "runs/v1/dev"), { recursive: true });
    await writeFile(
      join(root, "runs/v1/dev/proj.jsonl"),
      jsonl([
        { ticket: "TARS-10", outcome: "landed", started: recent(60), cost_usd: 4 },
        { ticket: "TARS-11", outcome: "bounced", failure_category: "spec_ambiguous", started: recent(60), cost_usd: 1 },
      ]),
    );
    await mkdir(join(root, "research-loop/runs"), { recursive: true });
    await writeFile(
      join(root, "research-loop/runs/proj.jsonl"),
      jsonl([
        { ticket: "TARS-20", outcome: "landed", started: recent(60), cost_usd: 7 },
        { ticket: "TARS-21", outcome: "landed", started: recent(60), cost_usd: 1 },
        { ticket: "TARS-22", outcome: "error", failure_category: "agent_error", started: recent(60), cost_usd: 0.5 },
      ]),
    );
    // A pre-cutover dev log that must be ignored because runs/v1/dev/ exists.
    await writeFile(join(root, "runs/proj.jsonl"), jsonl([{ ticket: "TARS-99", outcome: "landed", started: recent(60), cost_usd: 50 }]));
  }

  it("v2 by default: per role, counted from phase entries, within the window", async () => {
    await fixtures();
    const out = await stats();
    expect(out).toContain(join(root, "runs/v2/proj.jsonl"));
    expect(out).toMatch(/research: 2 phase\(s\) -- 1 landed, 1 bounced, 0 error\/killed, cost \$3\.50/);
    expect(out).toMatch(/dev: 3 phase\(s\) -- 1 landed, 0 bounced, 2 error\/killed, cost \$3\.50/);
    expect(out).not.toMatch(/TARS-99|\$100/);
    expect(out).toContain("1 unreadable line(s) skipped");
  });

  it("--v1 reports v1 dev and v1 research separately and says which file it read", async () => {
    await fixtures();
    const out = await stats("--v1");
    expect(out).toContain(`v1 dev (${join(root, "runs/v1/dev/proj.jsonl")}`);
    expect(out).toContain(`v1 research (${join(root, "research-loop/runs/proj.jsonl")}`);
    expect(out).toMatch(/v1 dev[^\n]*\n[^\n]*2 run\(s\) -- 1 landed, 1 bounced, 0 error\/killed, cost \$5\.00/);
    expect(out).toMatch(/v1 research[^\n]*\n[^\n]*3 run\(s\) -- 2 landed, 0 bounced, 1 error\/killed, cost \$8\.50/);
    expect(out).not.toContain("TARS-99");
    expect(out).not.toContain("$50.00");
  });

  it("--v1 falls back to the pre-cutover dev log runs/<slug>.jsonl", async () => {
    await mkdir(join(root, "runs"), { recursive: true });
    await writeFile(join(root, "runs/proj.jsonl"), jsonl([{ ticket: "TARS-9", outcome: "landed", started: recent(5), cost_usd: 2 }]));
    const out = await stats("--v1");
    expect(out).toContain(`v1 dev (${join(root, "runs/proj.jsonl")}`);
    expect(out).toMatch(/1 run\(s\) -- 1 landed/);
    expect(out).toMatch(/v1 research: no log/);
  });

  it("no logs at all: says so, exit 0", async () => {
    expect(await stats()).toMatch(/no v2 log/i);
  });

  it("never writes: the state root is byte-identical after both modes", async () => {
    await fixtures();
    const before = await snapshot(root);
    await stats();
    await stats("--v1");
    await stats("--days=1");
    expect(await snapshot(root)).toEqual(before);
  });
});
