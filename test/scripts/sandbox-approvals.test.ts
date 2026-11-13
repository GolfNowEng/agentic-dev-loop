// scripts/sandbox-approvals.mjs driven as a subprocess against a temp state
// root (--root). It lists parked tickets and, with --clear=<KEY>, appends an
// "unparked" record. It only prints the adapter's approveHint, never runs it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readIterations, type IterationRecord } from "../../src/core/iteration-log.ts";

const run = promisify(execFile);
const SCRIPT = resolve(import.meta.dirname, "../../scripts/sandbox-approvals.mjs");

function parkedRec(ticket: string, role: "research" | "dev", extra: Partial<IterationRecord["parked"]> = {}): IterationRecord {
  return {
    ticket, session: "dev-1", loop_version: "2.0.0",
    started: "2026-11-11T01:00:00.000Z", ended: "2026-11-11T01:10:00.000Z",
    outcome: "parked", phases: [], resume: role,
    parked: {
      role, failure_category: "sandbox_denied",
      denied: [{ kind: "network", target: "evil.example" }, { kind: "credential", target: "GH_TOKEN" }],
      approveHint: "sbx policy allow network evil.example", cost_usd: 0.5, run_dir: "d", ...extra,
    },
  };
}
const landedRec = (ticket: string): IterationRecord => ({
  ticket, session: "dev-1", loop_version: "2.0.0",
  started: "2026-11-11T01:00:00.000Z", ended: "2026-11-11T01:10:00.000Z", outcome: "landed", phases: [],
});
function discoveredRec(ticket: string, extra: Partial<IterationRecord> = {}, hint: string | undefined = "sbx policy allow network evil.example"): IterationRecord {
  return {
    ticket, session: "dev-1", loop_version: "2.0.0",
    started: "2026-11-11T02:00:00.000Z", ended: "2026-11-11T02:30:00.000Z", outcome: "landed",
    phases: [
      {
        role: "dev", skill: "ticket-to-pr", skill_version: "x", model: "sonnet",
        started: "2026-11-11T02:00:00.000Z", ended: "2026-11-11T02:20:00.000Z",
        outcome: "landed", phase_reached: "pr", cost_usd: 1, tokens: { in: 1, out: 1 }, failure_category: null,
        detail: "ok", pr: null, run_dir: "d",
        sandbox: {
          adapter: "fake", instance: "dl-x", prepare_ms: 5,
          denied: [{ kind: "network", target: "evil.example" }],
          ...(hint !== undefined ? { approveHint: hint } : {}),
        },
      },
    ],
    ...extra,
  };
}
const jsonl = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";

describe("scripts/sandbox-approvals.mjs", () => {
  let root: string;
  let log: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "approvals-test-"));
    log = join(root, "runs/v2/proj.jsonl");
    await mkdir(join(root, "runs/v2"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const exec = (...args: string[]) => run(process.execPath, [SCRIPT, `--root=${root}`, "--project=proj", ...args]);

  it("an empty log prints the no-parked line", async () => {
    const { stdout } = await exec();
    expect(stdout.trim()).toBe(`No parked tickets in ${log}.`);
  });

  it("lists only parked tickets, with refused targets, the hint and the clear command", async () => {
    await writeFile(log, jsonl([parkedRec("TARS-1", "dev"), landedRec("TARS-2")]));
    const { stdout } = await exec();
    expect(stdout).toBe(
      [
        "TARS-1 (dev, parked 2026-11-11T01:10:00.000Z):",
        "  refused: network evil.example",
        "  refused: credential GH_TOKEN",
        "  to allow (run these yourself): sbx policy allow network evil.example",
        "  then: npm run sandbox:approvals -- --clear=TARS-1",
        "",
      ].join("\n"),
    );
    expect(stdout).not.toContain("TARS-2");
  });

  it("omits the allow line when there is no hint", async () => {
    await writeFile(log, jsonl([parkedRec("TARS-1", "research", { approveHint: undefined })]));
    const { stdout } = await exec();
    expect(stdout).not.toContain("to allow");
    expect(stdout).toContain("then: npm run sandbox:approvals -- --clear=TARS-1");
  });

  it("lists discover-mode denials from the latest record's phases, after the no-parked line", async () => {
    await writeFile(log, jsonl([discoveredRec("TARS-3")]));
    const { stdout } = await exec();
    expect(stdout).toBe(
      [
        `No parked tickets in ${log}.`,
        "",
        "Discovered in discover mode (not parked):",
        "TARS-3 (dev, 2026-11-11T02:20:00.000Z):",
        "  refused: network evil.example",
        "  to allow (run these yourself): sbx policy allow network evil.example",
        "",
      ].join("\n"),
    );
    expect(stdout).not.toContain("--clear=TARS-3");
  });

  it("reports both parked and discovered sections; omits the allow line without a hint", async () => {
    await writeFile(log, jsonl([parkedRec("TARS-1", "dev"), discoveredRec("TARS-3", {}, undefined)]));
    const { stdout } = await exec();
    expect(stdout).toContain("then: npm run sandbox:approvals -- --clear=TARS-1");
    expect(stdout).not.toContain("No parked tickets");
    const disc = stdout.slice(stdout.indexOf("Discovered in discover mode (not parked):"));
    expect(disc).toBe(["Discovered in discover mode (not parked):", "TARS-3 (dev, 2026-11-11T02:20:00.000Z):", "  refused: network evil.example", ""].join("\n"));
  });

  it("only the ticket's latest record counts for the discovered section", async () => {
    const later = { ...landedRec("TARS-3"), started: "2026-11-11T03:00:00.000Z", ended: "2026-11-11T03:10:00.000Z" };
    await writeFile(log, jsonl([discoveredRec("TARS-3"), later]));
    const { stdout } = await exec();
    expect(stdout.trim()).toBe(`No parked tickets in ${log}.`);
  });

  it("--clear=<KEY> appends an unparked record that resumes the parked role", async () => {
    await writeFile(log, jsonl([parkedRec("TARS-1", "research")]));
    const { stdout } = await exec("--clear=TARS-1");
    expect(stdout.trim()).toBe("TARS-1: unparked; the next loop iteration resumes its research phase.");
    const recs = await readIterations(log);
    expect(recs).toHaveLength(2);
    const latest = recs[1];
    expect(latest).toMatchObject({ ticket: "TARS-1", session: "approvals", outcome: "unparked", phases: [], resume: "research", detail: "cleared by sandbox:approvals" });
    const pkg = JSON.parse(await readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"));
    expect(latest.loop_version).toBe(pkg.version);
    expect((await exec()).stdout.trim()).toBe(`No parked tickets in ${log}.`);
  });

  it("--clear on a non-parked key exits 1 with the latest outcome", async () => {
    await writeFile(log, jsonl([landedRec("TARS-2")]));
    await expect(exec("--clear=TARS-2")).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("TARS-2 is not parked (latest outcome: landed)."),
    });
    await expect(exec("--clear=TARS-9")).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("TARS-9 is not parked (latest outcome: none)."),
    });
    expect(await readIterations(log)).toHaveLength(1);
  });

  it("refuses the space form --clear KEY, naming the replacement", async () => {
    await expect(exec("--clear", "TARS-1")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("use --clear=TARS-1"),
    });
  });

  it("rejects an invalid --project", async () => {
    await expect(run(process.execPath, [SCRIPT, `--root=${root}`, "--project=../x"])).rejects.toMatchObject({ code: 1 });
  });

  it("the script source has no child_process import (it prints, never runs)", async () => {
    const src = await readFile(SCRIPT, "utf8");
    expect(src).not.toMatch(/child_process/);
  });
});
