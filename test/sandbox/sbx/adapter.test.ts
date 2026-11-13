import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { CREATE_TIMEOUT_MS, makeSbxAdapter } from "../../../src/sandbox/sbx/adapter.ts";
import type { SbxResult, SbxRunner } from "../../../src/sandbox/sbx/run.ts";
import type { SandboxHandle } from "../../../src/sandbox/types.ts";

type Call = { args: string[]; opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv } };
const ok = (stdout = "", stderr = ""): SbxResult => ({ code: 0, stdout, stderr, timedOut: false });
const fail = (code: number | null, stderr: string, stdout = "", timedOut = false): SbxResult => ({ code, stdout, stderr, timedOut });

/** A recording fake runner; `respond` picks the answer per call (default: exit 0). */
function fakeRunner(respond: (args: string[]) => SbxResult = () => ok()): { run: SbxRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: SbxRunner = async (args, opts) => {
    calls.push({ args, opts });
    return respond(args);
  };
  return { run, calls };
}

const CFG = { kitDir: "/kit", envAllow: ["ANTHROPIC_DEFAULT_SONNET_MODEL", "EXTRA_NAME"] };
const N = "dl-12-webtarsthree-tars-1-dev-a1b2c3";
const H: SandboxHandle = { adapter: "sbx", instanceName: N };
const FIXTURE = readFileSync(join(import.meta.dirname, "../../fixtures/sbx/policy-log-blocked.json"), "utf8");

describe("sbx adapter: name and validateConfig", () => {
  it("is named sbx and validates with validateSbxConfig", () => {
    const a = makeSbxAdapter({ run: fakeRunner().run });
    expect(a.name).toBe("sbx");
    expect(() => a.validateConfig(undefined)).toThrow("sandbox.sbx: kitDir is required");
    expect(a.validateConfig({ kitDir: "/kit" })).toMatchObject({ kitDir: "/kit" });
  });
});

describe("sbx adapter: prepare", () => {
  it("creates with the exact argv and CREATE_TIMEOUT_MS", async () => {
    const f = fakeRunner();
    const h = await makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: ["/abs/root", "/abs/repo"], config: CFG });
    expect(h).toEqual({ adapter: "sbx", instanceName: N });
    expect(CREATE_TIMEOUT_MS).toBe(180_000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].args).toEqual(["create", "--name", N, "--no-progress", "--no-input", "claude", "--kit", "/kit", "/abs/root", "/abs/repo"]);
    expect(f.calls[0].opts?.timeoutMs).toBe(CREATE_TIMEOUT_MS);
  });

  it("passes --memory when configured", async () => {
    const f = fakeRunner();
    await makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: ["/abs/root"], config: { ...CFG, memory: "4g" } });
    expect(f.calls[0].args).toEqual(["create", "--name", N, "--no-progress", "--no-input", "--memory", "4g", "claude", "--kit", "/kit", "/abs/root"]);
  });

  it("a non-zero exit throws with the code and the first stderr line", async () => {
    const f = fakeRunner(() => fail(2, "boom: no daemon\nsecond line"));
    await expect(makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: [], config: CFG })).rejects.toThrow(
      "sbx create failed (2): boom: no daemon",
    );
  });

  it("a timeout throws naming the timeout", async () => {
    const f = fakeRunner(() => fail(null, "slow", "", true));
    await expect(makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: [], config: CFG })).rejects.toThrow(
      "sbx create failed (timeout): slow",
    );
  });

  it("a config without kitDir throws a clear error", async () => {
    const a = makeSbxAdapter({ run: fakeRunner().run });
    await expect(a.prepare({ instanceName: N, mounts: [], config: undefined })).rejects.toThrow(/kitDir/);
  });
});

describe("sbx adapter: wrap", () => {
  const adapter = makeSbxAdapter({ run: fakeRunner().run });

  async function handle(): Promise<SandboxHandle> {
    return adapter.prepare({ instanceName: N, mounts: [], config: CFG });
  }

  it("execs claude in the instance with -w and -e for allowlisted names present in env", async () => {
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: "model-x", OTHER: "o", PATH: "/usr/bin" };
    const opts = { cwd: "/abs/root", env };
    const w = adapter.wrap(await handle(), "claude", ["-p", "hi"], opts);
    expect(w.cmd).toBe("sbx");
    expect(w.args).toEqual(["exec", "-w", "/abs/root", "-e", "ANTHROPIC_DEFAULT_SONNET_MODEL", N, "claude", "-p", "hi"]);
    expect(w.opts).toBe(opts);
  });

  it("omits -w when cwd is absent", async () => {
    const w = adapter.wrap(await handle(), "claude", ["-p"], { env: {} });
    expect(w.args).toEqual(["exec", N, "claude", "-p"]);
  });

  it("never puts an env value into args", async () => {
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: "value-sonnet-1", EXTRA_NAME: "value-extra-2", SECRETISH: "value-secret-3" };
    const w = adapter.wrap(await handle(), "claude", ["-p"], { cwd: "/abs/root", env });
    expect(w.args).toContain("EXTRA_NAME");
    for (const v of Object.values(env)) for (const a of w.args) expect(a.includes(v), `${v} in ${a}`).toBe(false);
  });
});

describe("sbx adapter: inspect", () => {
  it("maps the captured policy log's blocked hosts to network denials with an approve hint", async () => {
    const f = fakeRunner(() => ok(FIXTURE));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 0);
    expect(f.calls.map((c) => c.args)).toEqual([["policy", "log", N, "--json"]]);
    expect(f.calls[0].opts?.timeoutMs).toBeUndefined();
    expect(r.denied).toEqual([{ kind: "network", target: "example.org:443" }]);
    expect(r.approveHint).toBe("Review, then run yourself if you approve:\nsbx policy allow network example.org");
  });

  it("exit 125 is an sbx exec infra denial", async () => {
    const f = fakeRunner(() => ok('{"allowed":[],"blocked":[]}'));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 125);
    expect(r.denied).toEqual([{ kind: "infra", target: "sbx exec" }]);
    expect(r.approveHint).toBeUndefined();
  });

  it("nothing blocked: no denials, no hint", async () => {
    const f = fakeRunner(() => ok('{"allowed":[],"blocked":[]}'));
    expect(await makeSbxAdapter({ run: f.run }).inspect(H, 0)).toEqual({ denied: [] });
  });

  it("de-duplicates hosts in the hint, one line per host without the port", async () => {
    const log = { allowed: [], blocked: [{ host: "a.example:443" }, { host: "a.example:80" }, { host: "b.example:443" }, { host: "a.example:443" }] };
    const f = fakeRunner(() => ok(JSON.stringify(log)));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 1);
    expect(r.denied).toEqual([
      { kind: "network", target: "a.example:443" },
      { kind: "network", target: "a.example:80" },
      { kind: "network", target: "b.example:443" },
    ]);
    expect(r.approveHint).toBe("Review, then run yourself if you approve:\nsbx policy allow network a.example\nsbx policy allow network b.example");
  });

  it("a failed policy log call is an infra denial, never a throw", async () => {
    const f = fakeRunner(() => fail(1, "error: daemon down"));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 125);
    expect(r.denied).toEqual([
      { kind: "infra", target: "sbx exec" },
      { kind: "infra", target: "policy log" },
    ]);
  });

  it("unparseable policy log JSON is an infra denial, never a throw", async () => {
    for (const out of ["not json", "null", '{"blocked":"x"}']) {
      const f = fakeRunner(() => ok(out));
      expect((await makeSbxAdapter({ run: f.run }).inspect(H, 0)).denied).toEqual([{ kind: "infra", target: "policy log" }]);
    }
  });
});

describe("sbx adapter: teardown", () => {
  it("runs rm --force on the instance", async () => {
    const f = fakeRunner();
    await expect(makeSbxAdapter({ run: f.run }).teardown(H)).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([["rm", "--force", N]]);
  });

  it("a not-found stderr is done", async () => {
    const f = fakeRunner(() => fail(1, `error: sandbox '${N}' not found`));
    await expect(makeSbxAdapter({ run: f.run }).teardown(H)).resolves.toBeUndefined();
  });

  it("twice runs rm twice and both resolve", async () => {
    let n = 0;
    const f = fakeRunner(() => (n++ === 0 ? ok() : fail(1, `error: sandbox '${N}' not found`)));
    const a = makeSbxAdapter({ run: f.run });
    await expect(a.teardown(H)).resolves.toBeUndefined();
    await expect(a.teardown(H)).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([["rm", "--force", N], ["rm", "--force", N]]);
  });

  it("any other failure throws (spawn-claude logs it)", async () => {
    const f = fakeRunner(() => fail(1, "error: daemon down"));
    await expect(makeSbxAdapter({ run: f.run }).teardown(H)).rejects.toThrow("sbx rm failed (1): error: daemon down");
  });
});

describe("sbx adapter: cleanupOrphans", () => {
  it("removes only names that start with the prefix, one rm per name", async () => {
    const list = [{ name: "dl-1-a-x-1-dev-aaaaaa" }, { name: "dl-3-a-b-x-1-dev-bbbbbb" }, { name: "dl-1-a-y-2-research-cccccc" }, { name: "other" }];
    const f = fakeRunner((args) => (args[0] === "ls" ? ok(JSON.stringify(list)) : ok()));
    await expect(makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-1-a-" })).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([
      ["ls", "--json"],
      ["rm", "--force", "dl-1-a-x-1-dev-aaaaaa"],
      ["rm", "--force", "dl-1-a-y-2-research-cccccc"],
    ]);
  });

  it("the other project's prefix removes only its own", async () => {
    const list = [{ name: "dl-1-a-x-1-dev-aaaaaa" }, { name: "dl-3-a-b-x-1-dev-bbbbbb" }];
    const f = fakeRunner((args) => (args[0] === "ls" ? ok(JSON.stringify(list)) : ok()));
    await makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-3-a-b-" });
    expect(f.calls.map((c) => c.args)).toEqual([["ls", "--json"], ["rm", "--force", "dl-3-a-b-x-1-dev-bbbbbb"]]);
  });

  it("a failed ls throws sbx ls failed", async () => {
    const f = fakeRunner(() => fail(1, "error: daemon down"));
    await expect(makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-1-a-" })).rejects.toThrow(/^sbx ls failed: /);
  });

  it("unparseable ls output throws sbx ls failed", async () => {
    const f = fakeRunner(() => ok("nope"));
    await expect(makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-1-a-" })).rejects.toThrow(/^sbx ls failed: /);
  });

  it("an empty list removes nothing", async () => {
    const f = fakeRunner(() => ok("[]"));
    await makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-1-a-" });
    expect(f.calls.map((c) => c.args)).toEqual([["ls", "--json"]]);
  });
});

describe("sbx adapter: preflight", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sbx-preflight-"));
  const kit = join(tmp, "kit");
  mkdirSync(kit);
  writeFileSync(join(kit, "spec.yaml"), "name: kit\n");
  const emptyKit = join(tmp, "empty-kit");
  mkdirSync(emptyKit);
  writeFileSync(join(emptyKit, "README"), "x");
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const P = "dl-12-webtarsthree-preflight-abc123";
  const CHECK = ["exec", P, "sh", "-c", "node --version && git --version && gh auth status"];
  const identity = (p: string) => p;
  const ctx = (over: Partial<{ kitDir: string; mounts: string[]; cwd: string }> = {}) => ({
    repoRoot: "/abs/root",
    mounts: over.mounts ?? ["/abs/root", "/abs/repo"],
    cwd: over.cwd ?? "/abs/root",
    instanceName: P,
    config: { kitDir: over.kitDir ?? kit, envAllow: [] },
  });
  const GOOD = ok("v24.3.0\ngit version 2.47.0\n", "Logged in to github.com\n");
  const answer = (exec: SbxResult) => (args: string[]) => (args[0] === "exec" ? exec : ok());

  it("creates, runs the check, and removes the instance", async () => {
    const f = fakeRunner(answer(GOOD));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24 }).preflight(ctx())).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([
      ["create", "--name", P, "--no-progress", "--no-input", "claude", "--kit", kit, "/abs/root", "/abs/repo"],
      CHECK,
      ["rm", "--force", P],
    ]);
    expect(f.calls[0].opts?.timeoutMs).toBe(CREATE_TIMEOUT_MS);
  });

  it("refuses a mount whose case differs from the disk's", async () => {
    const f = fakeRunner();
    const realpath = (p: string) => p.replace("/abs/repos/", "/abs/Repos/");
    await expect(
      makeSbxAdapter({ run: f.run, realpath, hostNodeMajor: 24 }).preflight(ctx({ mounts: ["/abs/repos/x"], cwd: "/abs/Repos/x" })),
    ).rejects.toThrow('sandbox paths must match the disk\'s real case: "/abs/repos/x" is "/abs/Repos/x" on disk; cd into the real path and restart');
    expect(f.calls).toEqual([]);
  });

  it("refuses a cwd whose case differs from the disk's", async () => {
    const realpath = (p: string) => p.replace("/abs/root", "/abs/Root");
    await expect(
      makeSbxAdapter({ run: fakeRunner().run, realpath, hostNodeMajor: 24 }).preflight(ctx({ mounts: [], cwd: "/abs/root" })),
    ).rejects.toThrow('"/abs/root" is "/abs/Root" on disk');
  });

  it("refuses a kitDir with no yaml, or one that does not exist", async () => {
    for (const dir of [emptyKit, join(tmp, "missing")]) {
      const f = fakeRunner();
      await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24 }).preflight(ctx({ kitDir: dir }))).rejects.toThrow(
        `sandbox.sbx.kitDir "${dir}" has no kit yaml`,
      );
      expect(f.calls).toEqual([]);
    }
  });

  it("refuses a node major different from the host's, and still removes the instance", async () => {
    const f = fakeRunner(answer(ok("v22.1.0\ngit version 2.47.0\n")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24 }).preflight(ctx())).rejects.toThrow(
      "sandbox image has no node 24: add node to the kit (see docs/sandbox-sbx.md)",
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "--force", P]);
  });

  it("refuses a missing node", async () => {
    const f = fakeRunner(answer(fail(127, "sh: 1: node: not found")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24 }).preflight(ctx())).rejects.toThrow(
      "sandbox image has no node 24: add node to the kit (see docs/sandbox-sbx.md)",
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "--force", P]);
  });

  it("refuses when gh is not logged in, and still removes the instance", async () => {
    const f = fakeRunner(answer(fail(1, "You are not logged into any GitHub hosts.", "v24.3.0\ngit version 2.47.0\n")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24 }).preflight(ctx())).rejects.toThrow(
      "gh is not logged in inside the sandbox: run sbx secret set github (see docs/sandbox-sbx.md)",
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "--force", P]);
  });

  it("any other exec failure is sbx preflight failed with the first stderr line", async () => {
    const f = fakeRunner(answer(fail(125, `error: sandbox '${P}' not found\nmore`)));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24 }).preflight(ctx())).rejects.toThrow(
      `sbx preflight failed: error: sandbox '${P}' not found`,
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "--force", P]);
  });

  it("a failed create is sbx preflight failed, and still removes the instance", async () => {
    const f = fakeRunner((args) => (args[0] === "create" ? fail(1, "error: no daemon") : ok()));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24 }).preflight(ctx())).rejects.toThrow(
      /^sbx preflight failed: .*error: no daemon/,
    );
    expect(f.calls.map((c) => c.args[0])).toEqual(["create", "rm"]);
  });

  it("defaults hostNodeMajor to the running node's major", async () => {
    const major = process.versions.node.split(".")[0];
    const f = fakeRunner(answer(ok(`v${major}.0.0\ngit version 2.47.0\n`)));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity }).preflight(ctx())).resolves.toBeUndefined();
  });
});
