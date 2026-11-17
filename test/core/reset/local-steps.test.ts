import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSteps } from "../../../src/core/reset/local-steps.ts";
import type { ResetCtx } from "../../../src/core/reset/context.ts";
import type { Survey } from "../../../src/core/reset/step.ts";

const P = "proj";
const SESSIONS = `.pipeline/v2/${P}/sessions`;
const NOW = new Date("2026-11-16T12:00:00.000Z");

function phase(role: "research" | "dev", outcome = "landed", pr: string | null = null) {
  return { role, skill: "s", skill_version: "s", model: "m", started: "2026-11-10T00:00:00.000Z", ended: "2026-11-10T00:01:00.000Z", outcome, phase_reached: "pr", cost_usd: 1, tokens: { in: 1, out: 1 }, failure_category: null, detail: "d", pr, run_dir: "d" };
}
function rec(ticket: string, phases: object[], extra: object = {}): string {
  return JSON.stringify({ ticket, session: "dev-1", loop_version: "2.0.0", started: "2026-11-10T00:00:00.000Z", ended: "2026-11-10T00:01:00.000Z", outcome: "landed", phases, ...extra });
}
async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}
const exists = (p: string) => stat(p).then(() => true, () => false);

describe("local reset steps", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reset-local-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (over: Partial<ResetCtx> = {}): ResetCtx => ({
    project: P, slug: P, ticket: "TARS-1", role: "all", config: null, root,
    jira: null, github: null, openPrHeads: null, git: async () => "", sandbox: null, sandboxConfig: null,
    isAlive: () => false, now: () => NOW, closeRemote: false, ...over,
  });
  const surveyAll = async (c: ResetCtx): Promise<{ steps: ReturnType<typeof localSteps>; s: Survey[] }> => {
    const steps = localSteps(c);
    const s: Survey[] = [];
    for (const st of steps) s.push(await st.survey());
    return { steps, s };
  };
  const lockBody = JSON.stringify({ pid: 99999999, started: 1000, inFlight: { ticket: "TARS-1", role: "dev", runDir: "x", since: "2026-11-10T01:00:00.000Z" } });
  async function build(): Promise<void> {
    await put(root, `runs/v2/${P}.jsonl`, [rec("TARS-1", [phase("dev")]), rec("TARS-2", [phase("dev")])].join("\n") + "\n");
    await put(root, `.pipeline/v2/${P}/dev-1/TARS-1/dev-20261110T010000Z/usage.json`, "{}");
    await put(root, `.pipeline/v2/${P}/dev-1/TARS-1/research-20261110T000000Z/usage.json`, "{}");
    await put(root, `${SESSIONS}/dev-1.lock`, lockBody);
  }

  it("surveys records, dirs and a dead lock's flight for the ticket", async () => {
    await build();
    const { steps, s } = await surveyAll(ctx());
    expect(steps.map((x) => x.name)).toEqual(["run records", "run dirs", "session lock in-flight", "recent-window hold"]);
    expect(s[0]).toMatchObject({ found: `1 records in runs/v2/${P}`, action: "archive 1" });
    expect(s[1]).toMatchObject({ found: "dev-20261110T010000Z, research-20261110T000000Z", action: "delete 2" });
    expect(s[2]).toMatchObject({ found: "dev-1.lock (holder dead) -> all run", action: "clear" });
    expect(s[3]).toEqual({ found: "none", action: null });
  });

  it("run archives, deletes and clears; re-survey is clean", async () => {
    await build();
    const c = ctx();
    const { s } = await surveyAll(c);
    for (const x of s) await x.run?.();
    expect(await exists(join(root, `.pipeline/v2/${P}/dev-1/TARS-1/dev-20261110T010000Z`))).toBe(false);
    expect(JSON.parse(await readFile(join(root, SESSIONS, "dev-1.lock"), "utf8")).inFlight).toBeNull();
    expect(await readFile(join(root, `runs/v2/${P}.jsonl`), "utf8")).toContain("TARS-2");
    const again = await surveyAll(c);
    for (const x of again.s) expect(x).toEqual({ found: "none", action: null });
  });

  it("dev scope keeps research records", async () => {
    await put(root, `runs/v2/${P}.jsonl`, [rec("TARS-1", [phase("research")]), rec("TARS-1", [phase("dev", "bounced")])].join("\n") + "\n");
    const { s } = await surveyAll(ctx({ role: "dev" }));
    expect(s[0]).toMatchObject({ found: `1 records in runs/v2/${P}`, action: "archive 1" });
    await s[0].run!();
    const left = (await readFile(join(root, `runs/v2/${P}.jsonl`), "utf8")).trim().split("\n");
    expect(left).toHaveLength(1);
    expect(left[0]).toContain('"role":"research"');
  });

  it("a refused cross-role record is needs you", async () => {
    await put(root, `runs/v2/${P}.jsonl`, rec("TARS-1", [phase("research"), phase("dev", "landed", "http://pr/1")]) + "\n");
    const { s } = await surveyAll(ctx({ role: "research" }));
    expect(s[0].needsYou).toBe("other role landed; --include-cross-role");
    expect(s[0].run).toBeUndefined();
    expect(s[0].found).toContain("1 refused");
  });

  it("archives safe records and lists refused ones when both exist", async () => {
    await put(root, `runs/v2/${P}.jsonl`, [rec("TARS-1", [phase("research")]), rec("TARS-1", [phase("research"), phase("dev", "landed", "http://pr/1")])].join("\n") + "\n");
    const c = ctx({ role: "research" });
    const { s } = await surveyAll(c);
    expect(s[0].action).toBe("archive 1");
    expect(s[0].run).toBeDefined();
    expect(s[0].needsYou).toBeUndefined();
    expect(s[0].details?.join("\n")).toMatch(/kept: TARS-1 record \(other role landed: dev http:\/\/pr\/1\)/);
    await s[0].run!();
    const after = (await surveyAll(c)).s[0];
    expect(after.found).toBe("none, 1 refused");
    expect(after.action).toBeNull();
    expect(after.needsYou).toBe("other role landed; --include-cross-role");
  });

  it("recent-window hold reads held before and none after archive", async () => {
    const ended = new Date(NOW.getTime() - 45_500).toISOString();
    await put(root, `runs/v2/${P}.jsonl`, rec("TARS-1", [phase("dev")], { ended, jira_status_changed: true }) + "\n");
    const c = ctx();
    const { s } = await surveyAll(c);
    // 120s hold, ended 45.5s ago: 74.5s left, rounded up.
    expect(s[3]).toEqual({ found: "held (ended 45s ago)", action: null, needsYou: "held for 75s more by the recent-window hold" });
    expect(s[3].run).toBeUndefined();
    await s[0].run!();
    expect((await surveyAll(c)).s[3]).toEqual({ found: "none", action: null });
  });

  it("never touches worktrees", async () => {
    const wt = join(root, "target", ".claude", "worktrees", "TARS-1-dev");
    await put(root, "target/.claude/worktrees/TARS-1-dev/f", "x");
    await put(root, `runs/v2/${P}.jsonl`, rec("TARS-1", [phase("dev")]) + "\n");
    const config = { targetRepo: { url: "git@github.com:o/p.git", defaultBranch: "main", path: join(root, "target") } } as never;
    const { s } = await surveyAll(ctx({ config }));
    for (const x of s) await x.run?.();
    expect(await exists(wt)).toBe(true);
  });
});
