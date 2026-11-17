import { describe, expect, it } from "vitest";
import { sandboxSteps } from "../../../src/core/reset/sandbox-steps.ts";
import type { ResetCtx } from "../../../src/core/reset/context.ts";
import { makeSbxAdapter } from "../../../src/sandbox/sbx/adapter.ts";
import { noneAdapter } from "../../../src/sandbox/none.ts";
import type { SbxResult, SbxRunner } from "../../../src/sandbox/sbx/run.ts";

const ok = (stdout = ""): SbxResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const ls = (...names: string[]): SbxResult => ok(JSON.stringify(names.map((name) => ({ name }))));
const CFG = { kitDir: "/kit", envAllow: [] };

function ctx(run: SbxRunner | null): ResetCtx {
  return {
    project: "webtarsthree",
    slug: "webtarsthree",
    ticket: "TARS-1634",
    sandbox: run ? makeSbxAdapter({ run }) : noneAdapter,
    sandboxConfig: CFG,
  } as unknown as ResetCtx;
}

describe("sandbox reset steps", () => {
  it("lists and removes only this ticket's instances", async () => {
    const calls: string[][] = [];
    const run: SbxRunner = async (args) => {
      calls.push(args);
      return args[0] === "ls"
        ? ls("dl-12-webtarsthree-tars-1634-dev-abc123", "dl-12-webtarsthree-tars-16340-dev-x", "dl-12-webtarsthree-preflight-y")
        : ok();
    };
    const steps = sandboxSteps(ctx(run));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ area: "sandbox", name: "leftover sandboxes" });
    const s = await steps[0].survey();
    expect(s.found).toBe("dl-12-webtarsthree-tars-1634-dev-abc123");
    expect(s.action).toBe("remove 1");
    await s.run!();
    expect(calls).toEqual([["ls", "--json"], ["rm", "-f", "dl-12-webtarsthree-tars-1634-dev-abc123"]]);
  });

  it("reports none when nothing matches", async () => {
    const s = await sandboxSteps(ctx(async () => ls("dl-12-webtarsthree-preflight-y")))[0].survey();
    expect(s).toMatchObject({ found: "none", action: null });
    expect(s.run).toBeUndefined();
  });

  it("sbx ls failing is needs you", async () => {
    const run: SbxRunner = async () => ({ code: 1, stdout: "", stderr: "daemon down\nmore", timedOut: false });
    const s = await sandboxSteps(ctx(run))[0].survey();
    expect(s.needsYou).toBe("sbx ls failed: (1) daemon down");
    expect(s.run).toBeUndefined();
  });

  it("a missing sbx binary or unparseable output is needs you", async () => {
    const missing = await sandboxSteps(ctx(async () => { throw new Error("spawn sbx ENOENT"); }))[0].survey();
    expect(missing.needsYou).toBe("sbx ls failed: spawn sbx ENOENT");
    const bad = await sandboxSteps(ctx(async () => ok("nope")))[0].survey();
    expect(bad.needsYou).toMatch(/^sbx ls failed: unparseable/);
  });

  it("keeps removing after a failure and names each failure", async () => {
    const a = "dl-12-webtarsthree-tars-1634-dev-a";
    const b = "dl-12-webtarsthree-tars-1634-dev-b";
    const c = "dl-12-webtarsthree-tars-1634-qa-c";
    const rm: string[] = [];
    const run: SbxRunner = async (args) => {
      if (args[0] === "ls") return ls(a, b, c);
      rm.push(args[2]);
      return args[2] === a || args[2] === b ? { code: 1, stdout: "", stderr: "busy", timedOut: false } : ok();
    };
    const s = await sandboxSteps(ctx(run))[0].survey();
    await expect(s.run!()).rejects.toThrow(new RegExp(`${a}.*busy[\\s\\S]*${b}.*busy`));
    expect(rm).toEqual([a, b, c]);
  });

  it("never calls sbx policy or secret", async () => {
    const seen: string[] = [];
    await sandboxSteps(ctx(async (args) => { seen.push(args[0]); return ls(); }))[0].survey();
    expect(seen).toEqual(["ls"]);
  });

  it("none adapter has no reset steps", () => {
    expect(sandboxSteps(ctx(null))).toEqual([]);
    expect(sandboxSteps({ ...ctx(null), sandbox: null })).toEqual([]);
  });
});
