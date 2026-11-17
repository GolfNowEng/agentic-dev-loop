// executeReset failing: one attempt per pass, every local acting row reports it.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executeReset = vi.fn();
vi.mock("../../../src/core/reset-project.ts", async (orig) => ({
  ...(await orig<typeof import("../../../src/core/reset-project.ts")>()),
  executeReset: (...a: unknown[]) => executeReset(...a),
}));
const { localSteps } = await import("../../../src/core/reset/local-steps.ts");
import type { ResetCtx } from "../../../src/core/reset/context.ts";

describe("local steps: a failed executeReset", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "reset-local-fail-"));
    const phase = { role: "dev", skill: "s", skill_version: "s", model: "m", started: "2026-11-10T00:00:00.000Z", ended: "2026-11-10T00:01:00.000Z", outcome: "landed", phase_reached: "pr", cost_usd: 1, tokens: { in: 1, out: 1 }, failure_category: null, detail: "d", pr: null, run_dir: "d" };
    await mkdir(join(root, "runs/v2"), { recursive: true });
    await writeFile(join(root, "runs/v2/proj.jsonl"), JSON.stringify({ ticket: "TARS-1", session: "dev-1", loop_version: "2.0.0", started: phase.started, ended: phase.ended, outcome: "landed", phases: [phase] }) + "\n");
    await mkdir(join(root, ".pipeline/v2/proj/dev-1/TARS-1/dev-20261110T000000Z"), { recursive: true });
    await mkdir(join(root, ".pipeline/v2/proj/sessions"), { recursive: true });
    await writeFile(join(root, ".pipeline/v2/proj/sessions/dev-1.lock"), JSON.stringify({ pid: 99999999, started: 1000, inFlight: { ticket: "TARS-1", role: "dev", runDir: "x", since: "2026-11-10T01:00:00.000Z" } }));
    executeReset.mockReset();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (): ResetCtx => ({
    project: "proj", slug: "proj", ticket: "TARS-1", role: "all", config: null, root,
    jira: null, github: null, openPrHeads: null, git: async () => "", sandbox: null, sandboxConfig: null,
    isAlive: () => false, now: () => new Date("2026-11-16T12:00:00.000Z"), closeRemote: false,
  });

  it("executes once per pass; later rows rethrow the same error; a fresh survey re-arms", async () => {
    executeReset.mockRejectedValueOnce(new Error("disk full"));
    const steps = localSteps(ctx());
    const runs = [];
    for (const s of steps.slice(0, 3)) runs.push((await s.survey()).run!);
    for (const r of runs) await expect(r()).rejects.toThrow("disk full");
    expect(executeReset).toHaveBeenCalledTimes(1);

    executeReset.mockResolvedValueOnce({});
    const again = await steps[0].survey();
    await again.run!();
    expect(executeReset).toHaveBeenCalledTimes(2);
  });
});
