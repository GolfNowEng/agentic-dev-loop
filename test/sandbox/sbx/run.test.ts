import { describe, expect, it } from "vitest";
import { makeSbxRunner, SBX_CALL_TIMEOUT_MS, type SbxExecFile } from "../../../src/sandbox/sbx/run.ts";

describe("makeSbxRunner", () => {
  it("passes args verbatim, no shell, default timeout", async () => {
    let seen: { cmd: string; args: string[]; opts: Record<string, unknown> } | undefined;
    const fake: SbxExecFile = (cmd, args, opts, cb) => {
      seen = { cmd, args, opts };
      cb(null, "out", "err");
    };
    const r = await makeSbxRunner(fake)(["ls", "a b; rm -rf /"]);
    expect(seen?.cmd).toBe("sbx");
    expect(seen?.args).toEqual(["ls", "a b; rm -rf /"]);
    expect(seen?.opts.shell).toBeFalsy();
    expect(seen?.opts.timeout).toBe(SBX_CALL_TIMEOUT_MS);
    expect(r).toEqual({ code: 0, stdout: "out", stderr: "err", timedOut: false });
  });
  it("maps non-zero exit to code", async () => {
    const fake: SbxExecFile = (_c, _a, _o, cb) => cb(Object.assign(new Error("x"), { code: 3 }), "o", "e");
    expect((await makeSbxRunner(fake)(["x"])).code).toBe(3);
  });
  it("reports timedOut when killed", async () => {
    const fake: SbxExecFile = (_c, _a, _o, cb) => cb(Object.assign(new Error("x"), { killed: true, signal: "SIGTERM", code: null }), "", "");
    const r = await makeSbxRunner(fake)(["x"], { timeoutMs: 5 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });
});
