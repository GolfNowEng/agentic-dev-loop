import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jiraSteps } from "../../../src/core/reset/jira-steps.ts";
import type { RunWindow } from "../../../src/core/reset/run-windows.ts";
import type { ResetCtx } from "../../../src/core/reset/context.ts";
import type { ResetStep, Survey } from "../../../src/core/reset/step.ts";
import type { JiraClient, JiraComment } from "../../../src/core/jira-client.ts";
import type { Config } from "../../../src/core/types.ts";

const TRIGGER = "pipeline:research-v2";
const HANDOFF = "pipeline:dev-v2";
const TODO = "To Do";
const H = 3_600_000;
const BASE = Date.parse("2026-11-16T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "+0000");

/** In-memory Jira: every call is recorded in `calls`; writes also in `writes`. */
class FakeJira {
  calls: string[] = [];
  writes: string[] = [];
  status = "In Progress";
  labels: string[] = [];
  comments: JiraComment[] = [];
  refuse = new Map<string, number>();
  async getStatus(k: string) { this.calls.push(`getStatus ${k}`); return this.status; }
  async getLabels(k: string) { this.calls.push(`getLabels ${k}`); return [...this.labels]; }
  async listComments(k: string) { this.calls.push(`listComments ${k}`); return this.comments.map((c) => ({ ...c })); }
  async deleteComment(k: string, id: string) {
    this.writes.push(`deleteComment ${k} ${id}`);
    const status = this.refuse.get(id);
    if (status !== undefined) throw Object.assign(new Error(`Jira request failed: DELETE -> ${status}`), { status });
    this.comments = this.comments.filter((c) => c.id !== id);
  }
  async transitionStatus(k: string, to: string) { this.writes.push(`transitionStatus ${k} ${to}`); this.status = to; }
  async swapLabel(k: string, from: string, to: string) {
    this.writes.push(`swapLabel ${k} ${from} ${to}`);
    this.labels = [...this.labels.filter((l) => l !== from && l !== to), to];
  }
  async removeLabel(k: string, l: string) { this.writes.push(`removeLabel ${k} ${l}`); this.labels = this.labels.filter((x) => x !== l); }
  add(id: string, at: number, firstLine: string) {
    this.comments.push({ id, created: iso(at), firstLine, url: `https://jira.example/browse/TARS-1?focusedCommentId=${id}` });
  }
}

const config = { jira: { claimStatus: { from: TODO, to: "In Progress" } }, roles: { research: { triggerLabel: TRIGGER, handoffLabel: HANDOFF } } } as unknown as Config;

describe("jira reset steps", () => {
  let root: string;
  let jira: FakeJira;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "reset-jira-")));
    jira = new FakeJira();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (over: Partial<ResetCtx> = {}): ResetCtx => ({
    project: "proj", slug: "proj", ticket: "TARS-1", role: "all", config, root,
    jira: jira as unknown as JiraClient, github: null, openPrHeads: null, git: async () => "", sandbox: null, sandboxConfig: null,
    now: () => new Date(BASE), closeRemote: false, ...over,
  });
  const researchWin: RunWindow = { role: "research", from: BASE, to: BASE + H };
  const devWin: RunWindow = { role: "dev", from: BASE + 2 * H, to: BASE + 3 * H };
  const steps = (c: ResetCtx, w: RunWindow[] = [researchWin, devWin]): ResetStep[] => jiraSteps(c, async () => w);
  const step = (c: ResetCtx, name: string, w?: RunWindow[]): ResetStep => steps(c, w).find((s) => s.name === name)!;

  it("names the four steps in order", () => {
    expect(steps(ctx()).map((s) => [s.area, s.name])).toEqual([["jira", "status"], ["jira", "label"], ["jira", "loop comments"], ["jira", "follow-up tickets"]]);
  });

  it("deletes an in-window research comment", async () => {
    jira.add("1", BASE + 60_000, "✅ research-loop - refined");
    jira.add("2", BASE + 2 * H + 60_000, "## ❌ dev-loop - test-failure: x");
    const s = step(ctx(), "loop comments");
    const sv = await s.survey();
    expect(sv).toMatchObject({ found: "2 (1 research, 1 dev)", action: "delete 2" });
    expect(sv.details).toHaveLength(2);
    expect(sv.details![0]).toMatch(/^\d\d:\d\d ✅ research-loop - refined$/);
    await sv.run!();
    expect(jira.writes).toEqual(["deleteComment TARS-1 1", "deleteComment TARS-1 2"]);
    expect(await s.survey()).toEqual({ found: "none", action: null });
  });

  it("keeps an in-window comment with no loop prefix", async () => {
    jira.add("1", BASE + 60_000, "Looks good to me, will review");
    jira.add("2", BASE + 120_000, "research-loop said this is ready");
    const sv = await step(ctx(), "loop comments").survey();
    expect(sv).toEqual({ found: "none", action: null });
    expect(jira.writes).toEqual([]);
  });

  it("keeps a loop-prefixed comment outside every window", async () => {
    jira.add("1", BASE - 60_000, "✅ research-loop - before the run");
    jira.add("2", BASE + 1.5 * H, "✅ research-loop - between runs");
    const sv = await step(ctx(), "loop comments").survey();
    expect(sv).toEqual({ found: "none", action: null });
    expect(jira.writes).toEqual([]);
  });

  it("dev reset keeps research's comment", async () => {
    jira.add("1", BASE + 60_000, "✅ research-loop - refined");
    // A research-prefixed comment inside a dev window is not dev's either.
    jira.add("2", BASE + 2 * H + 30_000, "✅ research-loop - odd timing");
    jira.add("3", BASE + 2 * H + 60_000, "❌ dev-loop - blocked-attempts: 3 failed");
    const sv = await step(ctx({ role: "dev" }), "loop comments").survey();
    expect(sv).toMatchObject({ found: "1 (0 research, 1 dev)", action: "delete 1" });
    await sv.run!();
    expect(jira.writes).toEqual(["deleteComment TARS-1 3"]);
    expect(jira.comments.map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("a refused delete leaves the row failed and the re-survey needs you", async () => {
    jira.add("1", BASE + 60_000, "✅ research-loop - refined");
    jira.add("2", BASE + 120_000, "❌ research-loop - bounced");
    jira.refuse.set("1", 403);
    const s = step(ctx(), "loop comments");
    const sv = await s.survey();
    await expect(sv.run!()).rejects.toThrow("could not delete https://jira.example/browse/TARS-1?focusedCommentId=1: 403");
    expect(jira.writes).toEqual(["deleteComment TARS-1 1", "deleteComment TARS-1 2"]);
    const again = await s.survey();
    expect(again).toMatchObject({ found: "1 (1 research, 0 dev)", action: null, needsYou: "could not delete https://jira.example/browse/TARS-1?focusedCommentId=1: 403" });
    expect(again.run).toBeUndefined();
  });

  it("a refused comment stays listed after its window's run dir is gone", async () => {
    jira.add("1", BASE + 60_000, "✅ research-loop - refined");
    jira.refuse.set("1", 404);
    let calls = 0;
    const s = jiraSteps(ctx(), async () => (calls++ === 0 ? [researchWin] : [])).find((x) => x.name === "loop comments")!;
    await expect((await s.survey()).run!()).rejects.toThrow("could not delete");
    expect(await s.survey()).toMatchObject({ found: "1 (1 research, 0 dev)", needsYou: expect.stringContaining(": 404") });
  });

  it("status moves to claimStatus.from", async () => {
    const s = step(ctx({ role: "dev" }), "status");
    const sv = await s.survey();
    expect(sv).toMatchObject({ found: "In Progress", action: `move to ${TODO}` });
    await sv.run!();
    expect(jira.writes).toEqual([`transitionStatus TARS-1 ${TODO}`]);
    expect(await s.survey()).toEqual({ found: TODO, action: null });
  });

  it("label research: swap handoff to trigger", async () => {
    jira.labels = ["repo:x", HANDOFF];
    const s = step(ctx({ role: "research" }), "label");
    const sv = await s.survey();
    expect(sv).toMatchObject({ found: HANDOFF, action: `swap to ${TRIGGER}` });
    await sv.run!();
    expect(jira.writes).toEqual([`swapLabel TARS-1 ${HANDOFF} ${TRIGGER}`]);
    expect(await s.survey()).toEqual({ found: TRIGGER, action: null });
  });

  it("label dev: swap trigger to handoff", async () => {
    jira.labels = [TRIGGER];
    const s = step(ctx({ role: "dev" }), "label");
    const sv = await s.survey();
    expect(sv).toMatchObject({ found: TRIGGER, action: `swap to ${HANDOFF}` });
    await sv.run!();
    expect(jira.writes).toEqual([`swapLabel TARS-1 ${TRIGGER} ${HANDOFF}`]);
    expect(await s.survey()).toEqual({ found: HANDOFF, action: null });
  });

  it("never touches other labels", async () => {
    jira.labels = ["repo:x", "customer-bug", TRIGGER, HANDOFF];
    const sv = await step(ctx({ role: "all" }), "label").survey();
    expect(sv).toMatchObject({ found: `${TRIGGER}, ${HANDOFF}`, action: `swap to ${TRIGGER}` });
    await sv.run!();
    expect(jira.writes).toEqual([`swapLabel TARS-1 ${HANDOFF} ${TRIGGER}`]);
    for (const w of jira.writes) expect(w).not.toMatch(/repo:x|customer-bug/);
    expect(jira.labels.sort()).toEqual(["customer-bug", "repo:x", TRIGGER].sort());
    jira.labels = ["repo:x"];
    expect(await step(ctx(), "label").survey()).toMatchObject({ found: "none", action: `swap to ${TRIGGER}` });
  });

  it("lists follow-up tickets from dev phases and never acts", async () => {
    await mkdir(join(root, "runs/v2"), { recursive: true });
    const r = (phases: unknown[]) => JSON.stringify({ ticket: "TARS-1", session: "s", started: "x", ended: "x", outcome: "landed", phases });
    await writeFile(join(root, "runs/v2/proj.jsonl"), r([{ role: "dev", started: "a", ended: "b", follow_up: { ticket: "TARS-9", pr: null } }]) + "\n");
    await writeFile(join(root, "runs/v2/proj.reset-archive.jsonl"), r([{ role: "dev", started: "a", ended: "b", follow_up: { ticket: "TARS-8", pr: null } }]) + "\n");
    const sv = await step(ctx(), "follow-up tickets").survey();
    expect(sv).toEqual({ found: "TARS-9, TARS-8", action: null });
    expect(jira.writes).toEqual([]);
  });

  it("no credentials makes every row needs you", async () => {
    const out: Survey[] = [];
    for (const s of steps(ctx({ jira: null }))) out.push(await s.survey());
    expect(out).toHaveLength(4);
    for (const sv of out) expect(sv).toMatchObject({ action: null, needsYou: "no credentials" });
  });

  it("no project config makes status and label need you", async () => {
    expect(await step(ctx({ config: null }), "status").survey()).toMatchObject({ action: null, needsYou: "no project config" });
    expect(await step(ctx({ config: null }), "label").survey()).toMatchObject({ action: null, needsYou: "no project config" });
    expect(jira.writes).toEqual([]);
  });

  it("closeRemote yields no jira reset rows", () => {
    expect(jiraSteps(ctx({ closeRemote: true }), async () => [])).toEqual([]);
  });
});
