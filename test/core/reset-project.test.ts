import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  planReset,
  executeReset,
  describeResetPlan,
  describeResetSummary,
  type ResetPlan,
} from "../../src/core/reset-project.ts";
import type { Config } from "../../src/core/types.ts";
import { makeV2Config } from "../fixtures/config.ts";

const P = "proj";

function makeConfig(targetRepoPath?: string): Config {
  return makeV2Config((c) => {
    c.targetRepo = {
      url: "git@github.com:org/proj.git",
      defaultBranch: "main",
      ...(targetRepoPath ? { path: targetRepoPath } : {}),
    };
  });
}

function phase(role: "research" | "dev", outcome = "landed", pr: string | null = null) {
  return {
    role, skill: role === "dev" ? "ticket-to-pr" : "ticket-refine", skill_version: "s", model: "m",
    started: "2026-11-10T00:00:00.000Z", ended: "2026-11-10T00:01:00.000Z", outcome, phase_reached: "pr",
    cost_usd: 1, tokens: { in: 1, out: 1 }, failure_category: null, detail: "d", pr, run_dir: "d",
  };
}
function rec(ticket: string, phases: object[], extra: object = {}): string {
  return JSON.stringify({
    ticket, session: "dev-1", loop_version: "2.0.0", started: "2026-11-10T00:00:00.000Z",
    ended: "2026-11-10T00:01:00.000Z", outcome: "landed", phases, ...extra,
  });
}

const LOG = [
  rec("TARS-1", [phase("research")]), // 0: research only
  rec("TARS-2", [phase("dev")]), // 1: other ticket
  rec("TARS-1", [phase("research"), phase("dev", "bounced")]), // 2: both roles
  rec("TARS-1", [phase("dev", "error")]), // 3: dev only
  rec("TARS-1", [], { outcome: "interrupted", resume: "dev" }), // 4: dev resume marker
  rec("TARS-1", [], { outcome: "handoff-done" }), // 5: no role
  "{ truncated", // 6: unreadable
];

/** Every v1 location, in both layouts. Reset must never change one byte here. */
const V1_FILES: Record<string, string> = {
  [`runs/v1/dev/${P}.jsonl`]: '{"ticket":"TARS-1","outcome":"landed"}\n',
  [`runs/v1/research/${P}.jsonl`]: '{"ticket":"TARS-1","outcome":"landed"}\n',
  [`.pipeline/v1/dev/${P}/runs/TARS-1-20260101T000000Z/verdict.json`]: "{}",
  [`.pipeline/v1/research/${P}/runs/TARS-1-20260101T000000Z/verdict.json`]: "{}",
  [`runs/${P}.jsonl`]: '{"ticket":"TARS-1","outcome":"landed"}\n',
  [`runs/${P}.reset-archive.jsonl`]: '{"ticket":"TARS-1"}\n',
  [`.pipeline/${P}/runs/TARS-1-20260101T000000Z/verdict.json`]: "{}",
  [`.pipeline/${P}/raw-usage/TARS-1-x.json`]: "{}",
  [`research-loop/runs/${P}.jsonl`]: '{"ticket":"TARS-1","outcome":"landed"}\n',
  [`research-loop/.pipeline/${P}/runs/TARS-1-20260101T000000Z/verdict.json`]: "{}",
};

const RUN_DIRS = [
  `.pipeline/v2/${P}/dev-1/TARS-1/research-20261110T000000Z`,
  `.pipeline/v2/${P}/dev-1/TARS-1/dev-20261110T010000Z`,
  `.pipeline/v2/${P}/dev-2/TARS-1/dev-20261110T020000Z`,
  `.pipeline/v2/${P}/dev-1/TARS-2/dev-20261110T030000Z`,
];

const SESSIONS = `.pipeline/v2/${P}/sessions`;
const LEFTOVERS = [
  "dev-1.lock.adopted-20261110T000000Z-1-ab",
  ".acquire.stale-ab",
  ".acquire.reclaim-0123",
  ".acquire.release-1-ab",
  ".tmp-1-ab",
];
const KEEP_IN_SESSIONS = ["dev-1.lock", ".acquire", "dev-2.lock.stale-20261110T000000Z-1-ab"];

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}

async function build(root: string): Promise<void> {
  await put(root, `runs/v2/${P}.jsonl`, LOG.join("\n") + "\n");
  for (const d of RUN_DIRS) await put(root, `${d}/usage.json`, "{}");
  for (const f of [...LEFTOVERS, ...KEEP_IN_SESSIONS]) await put(root, `${SESSIONS}/${f}`, "{}");
  await put(root, `.pipeline/v2/${P}/repo/README`, "clone");
  await put(root, "runs/v2/other.jsonl", rec("TARS-1", [phase("dev")]) + "\n");
  await put(root, ".pipeline/v2/other/dev-1/TARS-1/dev-20261110T000000Z/usage.json", "{}");
  await put(root, ".pipeline/v2/other/sessions/.tmp-1-ab", "{}");
  for (const [rel, c] of Object.entries(V1_FILES)) await put(root, rel, c);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names.sort()) {
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

/** Every file and dir of both v1 layouts. */
async function v1Snapshot(root: string): Promise<Record<string, string>> {
  const all = await snapshot(root);
  return Object.fromEntries(
    Object.entries(all).filter(([p]) => {
      const rel = p.slice(root.length + 1);
      return !rel.startsWith("runs/v2") && !rel.startsWith(".pipeline/v2") && rel !== "runs/" && rel !== ".pipeline/";
    }),
  );
}

const liveLines = async (root: string) =>
  (await readFile(join(root, `runs/v2/${P}.jsonl`), "utf8")).split("\n").filter(Boolean);
const archiveLines = async (root: string) =>
  (await readFile(join(root, `runs/v2/${P}.reset-archive.jsonl`), "utf8")).split("\n").filter(Boolean);

describe("planReset / executeReset (v2 layout)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reset-project-test-"));
    await build(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to role all", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1" });
    expect(plan.role).toBe("all");
  });

  it("per-ticket, role all: every TARS-1 run dir in every session, every TARS-1 record", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1", role: "all" });
    expect(plan.wholeProject).toBe(false);
    expect(plan.runDirsToRemove).toEqual([RUN_DIRS[1], RUN_DIRS[0], RUN_DIRS[2]].map((d) => join(root, d)));
    expect(plan.recordsToArchive).toBe(5);
    expect(plan.sessionLeftoversToRemove).toEqual([]);

    const summary = await executeReset(plan);
    expect(summary.recordsArchived).toBe(5);
    expect(await liveLines(root)).toEqual([LOG[1], LOG[6]]);
    expect(await archiveLines(root)).toEqual([LOG[0], LOG[2], LOG[3], LOG[4], LOG[5]]);
    for (const d of RUN_DIRS.slice(0, 3)) expect(await exists(join(root, d))).toBe(false);
    expect(await exists(join(root, RUN_DIRS[3]))).toBe(true);
  });

  it("--role research leaves the dev-* dirs and archives only records with a research phase", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1", role: "research" });
    expect(plan.runDirsToRemove).toEqual([join(root, RUN_DIRS[0])]);
    await executeReset(plan);
    expect(await exists(join(root, RUN_DIRS[0]))).toBe(false);
    for (const d of RUN_DIRS.slice(1)) expect(await exists(join(root, d))).toBe(true);
    expect(await archiveLines(root)).toEqual([LOG[0], LOG[2]]);
    expect(await liveLines(root)).toEqual([LOG[1], LOG[3], LOG[4], LOG[5], LOG[6]]);
  });

  it("--role dev leaves research-* dirs; archives records with a dev phase or a dev resume, refusing one whose research landed", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1", role: "dev" });
    expect(plan.runDirsToRemove).toEqual([RUN_DIRS[1], RUN_DIRS[2]].map((d) => join(root, d)));
    expect(plan.refusedRecords).toEqual([{ ticket: "TARS-1", reason: "other role landed: research landed" }]);
    await executeReset(plan);
    expect(await exists(join(root, RUN_DIRS[0]))).toBe(true);
    expect(await exists(join(root, RUN_DIRS[3]))).toBe(true);
    expect(await archiveLines(root)).toEqual([LOG[3], LOG[4]]);
    expect(await liveLines(root)).toContain(LOG[2]);
  });

  it("whole project, role all: archives every line, removes every run dir, prunes only session leftovers", async () => {
    const plan = await planReset({ root, project: P, role: "all" });
    expect(plan.wholeProject).toBe(true);
    expect(plan.sessionLeftoversToRemove.map((p) => p.slice(join(root, SESSIONS).length + 1)).sort()).toEqual([...LEFTOVERS].sort());
    await executeReset(plan);
    expect(await exists(join(root, `runs/v2/${P}.jsonl`))).toBe(false);
    expect(await archiveLines(root)).toEqual(LOG);
    for (const d of RUN_DIRS) expect(await exists(join(root, d))).toBe(false);
    expect((await readdir(join(root, SESSIONS))).sort()).toEqual([...KEEP_IN_SESSIONS].sort());
    expect(await exists(join(root, `.pipeline/v2/${P}/repo/README`))).toBe(true);
    // another project is untouched
    expect(await exists(join(root, ".pipeline/v2/other/dev-1/TARS-1/dev-20261110T000000Z/usage.json"))).toBe(true);
    expect(await exists(join(root, ".pipeline/v2/other/sessions/.tmp-1-ab"))).toBe(true);
    expect(await readFile(join(root, "runs/v2/other.jsonl"), "utf8")).toBe(rec("TARS-1", [phase("dev")]) + "\n");
  });

  it("whole project, role research: only research-* dirs and research records", async () => {
    await executeReset(await planReset({ root, project: P, role: "research" }));
    expect(await exists(join(root, RUN_DIRS[0]))).toBe(false);
    for (const d of RUN_DIRS.slice(1)) expect(await exists(join(root, d))).toBe(true);
    expect(await archiveLines(root)).toEqual([LOG[0], LOG[2]]);
  });

  it("a per-ticket reset never prunes session leftovers", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1" });
    await executeReset(plan);
    expect((await readdir(join(root, SESSIONS))).length).toBe(LEFTOVERS.length + KEEP_IN_SESSIONS.length);
  });

  it("reports live session locks so the caller can warn", async () => {
    const plan = await planReset({ root, project: P });
    expect(plan.liveLocks).toEqual([join(root, SESSIONS, "dev-1.lock")]);
    expect(describeResetPlan(plan)).toMatch(/session lock.*dev-1\.lock/i);
  });

  for (const ticket of ["TARS-1", undefined]) {
    for (const role of ["research", "dev", "all"] as const) {
      it(`never touches runs/v1/, .pipeline/v1/ or the pre-cutover v1 folders (ticket ${ticket ?? "none"}, role ${role})`, async () => {
        const before = await v1Snapshot(root);
        expect(Object.keys(before).length).toBeGreaterThan(Object.keys(V1_FILES).length);
        await executeReset(await planReset({ root, project: P, ticket, role }));
        expect(await v1Snapshot(root)).toEqual(before);
      });
    }
  }

  it("executeReset refuses a plan naming a path outside the project's v2 state", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1" });
    const bad: ResetPlan = { ...plan, runDirsToRemove: [join(root, `.pipeline/${P}/runs/TARS-1-20260101T000000Z`)] };
    await expect(executeReset(bad)).rejects.toThrow(/outside/);
    expect(await exists(join(root, `.pipeline/${P}/runs/TARS-1-20260101T000000Z/verdict.json`))).toBe(true);
  });

  it("nothing to do: a ticket with no v2 state", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-999" });
    expect(plan.recordsToArchive).toBe(0);
    expect(plan.runDirsToRemove).toEqual([]);
    const before = await snapshot(root);
    await executeReset(plan);
    expect(await snapshot(root)).toEqual(before);
  });

  it("no v2 state at all: an empty plan, and executing it creates nothing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "reset-project-empty-"));
    try {
      const plan = await planReset({ root: empty, project: P });
      expect(plan.runsLogExists).toBe(false);
      expect(plan.recordsToArchive).toBe(0);
      await executeReset(plan);
      expect(await readdir(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("a second reset appends to the archive, never overwriting", async () => {
    await executeReset(await planReset({ root, project: P, ticket: "TARS-1", role: "research" }));
    await executeReset(await planReset({ root, project: P, ticket: "TARS-2" }));
    expect(await archiveLines(root)).toEqual([LOG[0], LOG[2], LOG[1]]);
  });

  it("worktrees: role-scoped by name (research = <TICKET>-*-ground), only for a per-ticket reset", async () => {
    const target = await mkdtemp(join(tmpdir(), "target-repo-test-"));
    try {
      const wt = join(target, ".claude", "worktrees");
      for (const n of ["TARS-1-20261110T000000Z", "TARS-1-20261110T000000Z-ground", "TARS-2-20261110T000000Z"]) {
        await mkdir(join(wt, n), { recursive: true });
      }
      const config = makeConfig(target);
      expect((await planReset({ root, project: P, ticket: "TARS-1", role: "research", config })).worktreesToRemove).toEqual([
        join(wt, "TARS-1-20261110T000000Z-ground"),
      ]);
      expect((await planReset({ root, project: P, ticket: "TARS-1", role: "dev", config })).worktreesToRemove).toEqual([
        join(wt, "TARS-1-20261110T000000Z"),
      ]);
      const all = await planReset({ root, project: P, ticket: "TARS-1", config });
      expect(all.worktreesToRemove).toEqual([join(wt, "TARS-1-20261110T000000Z"), join(wt, "TARS-1-20261110T000000Z-ground")]);
      expect((await planReset({ root, project: P, config })).worktreesToRemove).toEqual([]);
      await executeReset(all);
      expect(await readdir(wt)).toEqual(["TARS-2-20261110T000000Z"]);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("no worktree scan when config is null or targetRepo.path is unset", async () => {
    expect((await planReset({ root, project: P, ticket: "TARS-1", config: null })).worktreesToRemove).toEqual([]);
    expect((await planReset({ root, project: P, ticket: "TARS-1", config: makeConfig() })).worktreesToRemove).toEqual([]);
  });

  it("rejects an unsafe project or ticket", async () => {
    await expect(planReset({ root, project: "../x" })).rejects.toThrow();
    await expect(planReset({ root, project: P, ticket: "../TARS-1" })).rejects.toThrow();
  });
});

describe("cross-role safety: a role-scoped reset never drops the other role's landed phase by default", () => {
  let root: string;
  const PR = "https://github.com/org/proj/pull/7";
  const BOTH = rec("TARS-1", [phase("research"), phase("dev", "landed", PR)]);
  const RESEARCH_LANDED_DEV_ERROR = rec("TARS-1", [phase("research"), phase("dev", "error")]);
  const RESEARCH_ONLY = rec("TARS-1", [phase("research")]);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reset-cross-role-"));
    await put(root, `runs/v2/${P}.jsonl`, [RESEARCH_ONLY, BOTH, RESEARCH_LANDED_DEV_ERROR].join("\n") + "\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--role research refuses [research, dev landed PR] by default and keeps it in the live log", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1", role: "research" });
    expect(plan.refusedRecords).toEqual([{ ticket: "TARS-1", reason: `other role landed: dev ${PR}` }]);
    expect(plan.recordsToArchive).toBe(2);
    expect(describeResetPlan(plan)).toContain(`REFUSED (other role landed: dev ${PR})`);
    await executeReset(plan);
    expect(await liveLines(root)).toEqual([BOTH]);
    expect(await archiveLines(root)).toEqual([RESEARCH_ONLY, RESEARCH_LANDED_DEV_ERROR]);
  });

  it("--role research --include-cross-role archives it too", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1", role: "research", includeCrossRole: true });
    expect(plan.refusedRecords).toEqual([]);
    await executeReset(plan);
    expect(await archiveLines(root)).toEqual([RESEARCH_ONLY, BOTH, RESEARCH_LANDED_DEV_ERROR]);
  });

  it("--role dev refuses [research landed, dev error] (and the dev-landed one) by default", async () => {
    const plan = await planReset({ root, project: P, role: "dev" });
    expect(plan.refusedRecords.map((r) => r.reason)).toEqual(["other role landed: research landed", "other role landed: research landed"]);
    expect(plan.recordsToArchive).toBe(0);
    await executeReset(plan);
    expect(await liveLines(root)).toEqual([RESEARCH_ONLY, BOTH, RESEARCH_LANDED_DEV_ERROR]);
  });

  it("--role all is unaffected", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1" });
    expect(plan.refusedRecords).toEqual([]);
    expect(plan.recordsToArchive).toBe(3);
  });
});

describe("symlinks are never followed", () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reset-symlink-"));
    outside = await mkdtemp(join(tmpdir(), "reset-outside-"));
    await put(outside, "TARS-1/dev-20261110T000000Z/keep.txt", "precious");
    await put(outside, "dev-20261110T000000Z/keep.txt", "precious");
    await mkdir(join(root, `.pipeline/v2/${P}/dev-2`), { recursive: true });
    await symlink(outside, join(root, `.pipeline/v2/${P}/dev-1`));
    await symlink(outside, join(root, `.pipeline/v2/${P}/dev-2/TARS-1`));
    await put(root, `.pipeline/v2/${P}/dev-3/TARS-1/research-20261110T000000Z/usage.json`, "{}");
    await symlink(join(outside, "dev-20261110T000000Z"), join(root, `.pipeline/v2/${P}/dev-3/TARS-1/dev-20261110T000000Z`));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("skips a symlinked session, ticket or run dir with a WARNING, and never deletes outside", async () => {
    const plans = [];
    for (const ticket of ["TARS-1", undefined]) {
      const plan = await planReset({ root, project: P, ticket });
      expect(plan.runDirsToRemove).toEqual([join(root, `.pipeline/v2/${P}/dev-3/TARS-1/research-20261110T000000Z`)]);
      expect(plan.warnings.filter((w) => /symlink/.test(w))).toHaveLength(3);
      expect(describeResetPlan(plan)).toMatch(/WARNING: skipped symlink/);
      plans.push(plan);
    }
    for (const plan of plans) await executeReset(plan);
    expect(await readFile(join(outside, "TARS-1/dev-20261110T000000Z/keep.txt"), "utf8")).toBe("precious");
    expect(await readFile(join(outside, "dev-20261110T000000Z/keep.txt"), "utf8")).toBe("precious");
  });
});

describe("live worker guard", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reset-live-"));
    await put(root, `runs/v2/${P}.jsonl`, rec("TARS-1", [phase("dev")]) + "\n");
    await put(root, `${SESSIONS}/dev-1.lock`, JSON.stringify({ pid: 4242, started: 1000, inFlight: null }));
    await put(root, `${SESSIONS}/dev-2.lock`, JSON.stringify({ pid: 4343, started: 2000, inFlight: null }));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const isAlive = (pid: number, started: number) => pid === 4242 && started === 1000;

  it("lists only locks whose holder is alive (pid + start time)", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1", isAlive });
    expect(plan.liveWorkerLocks).toEqual([join(root, SESSIONS, "dev-1.lock")]);
    expect(plan.liveLocks).toHaveLength(2);
  });

  it("executeReset refuses while a live worker holds a lock, touching nothing", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1", isAlive });
    await expect(executeReset(plan)).rejects.toThrow(/live worker.*--ignore-live-worker/);
    expect(await liveLines(root)).toHaveLength(1);
  });

  it("--ignore-live-worker proceeds", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1", isAlive, ignoreLiveWorker: true });
    expect((await executeReset(plan)).recordsArchived).toBe(1);
  });

  it("dead locks don't block", async () => {
    const plan = await planReset({ root, project: P, ticket: "TARS-1", isAlive: () => false });
    expect(plan.liveWorkerLocks).toEqual([]);
    expect((await executeReset(plan)).recordsArchived).toBe(1);
  });
});

describe("describeResetPlan / describeResetSummary", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reset-describe-"));
    await build(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the role, counts, paths, and says v1 history is never touched", async () => {
    const text = describeResetPlan(await planReset({ root, project: P, ticket: "TARS-1", role: "research" }));
    expect(text).toContain("role: research");
    expect(text).toContain("archive 2 record(s)");
    expect(text).toContain("1 run dir(s)");
    expect(text).toContain(join(root, RUN_DIRS[0]));
    expect(text).toMatch(/v1 history.*never touched/);
  });

  it("an empty plan says nothing to do in every category", async () => {
    const text = describeResetPlan(await planReset({ root, project: P, ticket: "TARS-999" }));
    expect(text).toContain("no matching records");
    expect(text).toContain("no matching run dirs");
    expect(text).toContain("none matching");
  });

  it("whole project lists session leftovers", async () => {
    const text = describeResetPlan(await planReset({ root, project: P }));
    expect(text).toContain("WHOLE PROJECT");
    expect(text).toContain(`prune ${LEFTOVERS.length} session leftover(s)`);
  });

  it("summary reports what happened", async () => {
    const summary = await executeReset(await planReset({ root, project: P, ticket: "TARS-1" }));
    const text = describeResetSummary(summary);
    expect(text).toContain("5 record(s) archived to");
    expect(text).toContain("3 run dir(s) deleted");
  });

  it("shortens paths under the home directory to ~/...", () => {
    const plan: ResetPlan = {
      project: P,
      ticketKey: "TARS-1",
      role: "all",
      wholeProject: false,
      runsLogPath: join(homedir(), "x/runs/v2/proj.jsonl"),
      runsLogExists: true,
      runsLogArchivePath: join(homedir(), "x/runs/v2/proj.reset-archive.jsonl"),
      recordsToArchive: 1,
      runDirsToRemove: [join(homedir(), "x/.pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z")],
      sessionLeftoversToRemove: [],
      worktreesToRemove: [],
      liveLocks: [],
      liveWorkerLocks: [],
      ignoreLiveWorker: false,
      includeCrossRole: false,
      refusedRecords: [],
      warnings: [],
      root: join(homedir(), "x"),
      worktreesDir: null,
    };
    const text = describeResetPlan(plan);
    expect(text).not.toContain(homedir());
    expect(text).toContain("~/x/runs/v2/proj.jsonl");
  });
});
