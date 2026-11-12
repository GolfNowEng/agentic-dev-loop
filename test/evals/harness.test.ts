// The eval harness, verified without any outward action (Ruling 49):
// - pipeline.eval.config.json loads via the real loader and passes the
//   preflight guard;
// - `DRY_RUN=1 bash evals/run.sh clean` echoes every outward command as a
//   `DRY:` line and never runs one: a fake PATH dir comes first with
//   gh/claude/curl/npm stubs that record any call and exit 99;
// - run.sh refuses no args and an unknown scenario;
// - reset.sh closes nothing without --write;
// - no evals/*.sh line calls gh/curl/npm/claude except through `outward`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { loadConfig } from "../../src/core/config.ts";
import { checkEvalConfig, SANDBOX_REPO } from "../../evals/config-guard.mjs";
import { summarize } from "../../evals/report.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const rel = (p: string) => relative(ROOT, p);
const EVAL_CONFIG = join(ROOT, "pipeline.eval.config.json");
const STUBS = ["gh", "claude", "curl", "npm"] as const;

describe("pipeline.eval.config.json", () => {
  it("loads via the real loader and passes the preflight guard", async () => {
    const config = await loadConfig(EVAL_CONFIG);
    expect(checkEvalConfig(config, "2.0.0")).toEqual([]);
  });

  it("points at the sandbox, polls only eval tickets, and has the lower ceilings", async () => {
    const c = await loadConfig(EVAL_CONFIG);
    expect(SANDBOX_REPO).toBe("JustinChan-fd/dev-loop-eval-sandbox");
    expect(c.github.repo).toBe(SANDBOX_REPO);
    expect(c.targetRepo.url).toContain(SANDBOX_REPO);
    expect(c.targetRepo.path).toBeUndefined();
    for (const role of ["research", "dev"] as const) {
      expect(c.roles[role].pollJql).toContain('AND labels = "dev-loop-eval"');
      expect(c.roles[role].pollJql).not.toContain('!= "dev-loop-eval"');
    }
    expect(c.roles.research.ceilings.maxCostPerRunUsd).toBe(15);
    expect(c.roles.dev.ceilings.maxCostPerRunUsd).toBe(10);
    expect(c.ceilings.maxRunsPerDay).toBe(10);
  });

  it("the guard rejects a non-sandbox repo and a JQL without the eval label", async () => {
    const good = await loadConfig(EVAL_CONFIG);
    const otherRepo = structuredClone(good);
    otherRepo.github.repo = "fandango/webtarsthree";
    expect(checkEvalConfig(otherRepo, "2.0.0").join("\n")).toMatch(/github\.repo/);
    const noLabel = structuredClone(good);
    noLabel.roles.dev.pollJql = noLabel.roles.dev.pollJql.replace(' AND labels = "dev-loop-eval"', "");
    expect(checkEvalConfig(noLabel, "2.0.0").join("\n")).toMatch(/roles\.dev\.pollJql/);
    const excluded = structuredClone(good);
    excluded.roles.research.pollJql = excluded.roles.research.pollJql.replace('labels = "dev-loop-eval"', 'labels != "dev-loop-eval"');
    expect(checkEvalConfig(excluded, "2.0.0").join("\n")).toMatch(/roles\.research\.pollJql/);
    const otherTarget = structuredClone(good);
    otherTarget.targetRepo.url = "git@github.com:fandango/webtarsthree.git";
    expect(checkEvalConfig(otherTarget, "2.0.0").join("\n")).toMatch(/targetRepo\.url/);
  });

  it("the webtarsthree config fails the guard", async () => {
    const w = await loadConfig(join(ROOT, "pipeline.webtarsthree.config.json"));
    expect(checkEvalConfig(w, "2.0.0").length).toBeGreaterThan(0);
  });
});

describe("evals harness, dry run", () => {
  let tmp: string;
  let stubDir: string;
  let stateDir: string;
  let markers: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "eval-dry-"));
    stubDir = join(tmp, "bin");
    stateDir = join(tmp, "state");
    markers = join(tmp, "called");
    mkdirSync(stubDir);
    mkdirSync(markers);
    for (const name of STUBS) {
      const p = join(stubDir, name);
      writeFileSync(p, `#!/bin/sh\necho "$0 $*" > "${markers}/${name}"\nexit 99\n`);
      chmodSync(p, 0o755);
    }
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(ROOT, "evals", script), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? tmp,
        DRY_RUN: "1",
        EVAL_STATE_DIR: stateDir,
        // A node call that slipped past `outward` would load this missing
        // env file and exit non-zero, never the real .env (and no Jira
        // credentials are in this env at all).
        DEVLOOP_ENV_FILE: join(tmp, "no-such.env"),
        ...env,
      },
    });

  const stubsCalled = () => readdirSync(markers);
  const lines = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`.split("\n").filter((l) => l.trim() !== "");

  it("run.sh clean exits 0, echoes only DRY: lines for outward commands, and calls no stub", () => {
    const r = run("run.sh", ["clean"]);
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    const all = lines(r);
    const bad = all.filter((l) => !l.startsWith("DRY: ") && !l.startsWith("[eval] "));
    expect(bad).toEqual([]);
    const dry = all.filter((l) => l.startsWith("DRY: "));
    expect(dry.some((l) => l.includes("npm run loop -- --config pipeline.eval.config.json") && l.includes("--once"))).toBe(true);
    expect(dry.some((l) => l.includes("evals/jira.mjs create"))).toBe(true);
    expect(dry.some((l) => l.includes("gh auth status"))).toBe(true);
    expect(dry.some((l) => l.includes("evals/check-clean.mjs"))).toBe(true);
    // Lines that name an outward tool are only ever DRY: lines.
    const outwardNamed = all.filter((l) => /(^|\s)(gh|curl|claude|npm run loop)(\s|$)|jira\.mjs/.test(l));
    expect(outwardNamed.every((l) => l.startsWith("DRY: "))).toBe(true);
  });

  it("run.sh clean exports the eval keys and the sandbox GH_REPO, and records dry keys only in keys.dry", () => {
    const r = run("run.sh", ["clean"]);
    expect(r.status, r.stderr).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("[eval] DEVLOOP_EVAL_KEYS=DRY-1");
    expect(out).toContain("[eval] GH_REPO=JustinChan-fd/dev-loop-eval-sandbox");
    expect(existsSync(join(stateDir, "keys"))).toBe(false);
    expect(readFileSync(join(stateDir, "keys.dry"), "utf8").trim().split("\n")).toEqual(["DRY-1"]);
  });

  it("run.sh --all dry-runs all five scenarios without calling a stub", () => {
    const r = run("run.sh", ["--all"]);
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    for (const name of ["clean", "ambiguous", "dev-bounce", "blocked", "queue"]) {
      expect(r.stdout + r.stderr).toContain(`evals/check-${name}.mjs`);
    }
    // queue works two tickets: two loop iterations.
    const out = r.stdout + r.stderr;
    const queueLoops = out
      .slice(out.indexOf("[eval] scenario queue\n"))
      .split("\n")
      .filter((l) => l.includes("npm run loop"));
    expect(queueLoops.length).toBe(2);
  });

  it("run.sh with no args, an unknown name, or two names exits non-zero", () => {
    for (const args of [[], ["nope"], ["clean", "queue"]]) {
      const r = run("run.sh", args);
      expect(r.status, args.join(" ")).not.toBe(0);
    }
    expect(stubsCalled()).toEqual([]);
  });

  it("run.sh refuses to run for real when the config fails the guard", () => {
    const badConfig = join(tmp, "bad.config.json");
    const cfg = JSON.parse(readFileSync(EVAL_CONFIG, "utf8"));
    cfg.github.repo = "fandango/webtarsthree";
    writeFileSync(badConfig, JSON.stringify(cfg));
    const r = run("run.sh", ["clean"], { EVAL_CONFIG: badConfig });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain("npm run loop");
    expect(stubsCalled()).toEqual([]);
  });

  it("reset.sh without --write lists eligible keys and closes nothing", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "keys"), "TARS-9001\nTARS-9002\n");
    const r = run("reset.sh", []);
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    const out = r.stdout + r.stderr;
    expect(out).toContain("TARS-9001");
    expect(out).not.toMatch(/DRY: .*(close|PATCH)/);
    expect(out).toContain("--write");
  });

  it("reset.sh --write (dry) only echoes the closes, behind the sandbox guard", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "keys"), "TARS-9001\n");
    const r = run("reset.sh", ["--write"]);
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/DRY: .*jira\.mjs close TARS-9001/);
    expect(out).toMatch(/DRY: .*repos\/JustinChan-fd\/dev-loop-eval-sandbox\/pulls/);
  });

  it("reset.sh skips keys that are not well-formed", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "keys"), "TARS-9001\n$(rm -rf x)\n");
    const r = run("reset.sh", ["--write"]);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("rm -rf");
  });
});

describe("evals lib guards", () => {
  const lib = join(ROOT, "evals", "lib.sh");
  const sh = (body: string) =>
    spawnSync("bash", ["-c", `. "${lib}"; ${body}`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", DRY_RUN: "1" } });

  it("assert_repo accepts only the sandbox", () => {
    expect(sh(`assert_repo JustinChan-fd/dev-loop-eval-sandbox && echo ok`).stdout).toContain("ok");
    expect(sh(`assert_repo fandango/webtarsthree && echo ok`).status).not.toBe(0);
  });

  it("assert_clone refuses a clone whose origin is not the sandbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-clone-"));
    try {
      spawnSync("git", ["init", "-q", dir]);
      spawnSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:fandango/webtarsthree.git"]);
      expect(sh(`assert_clone "${dir}" && echo ok`).status).not.toBe(0);
      spawnSync("git", ["-C", dir, "remote", "set-url", "origin", "git@github.com:JustinChan-fd/dev-loop-eval-sandbox.git"]);
      expect(sh(`assert_clone "${dir}" && echo ok`).stdout).toContain("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("outward echoes in dry mode and runs otherwise", () => {
    expect(sh(`outward echo hi`).stderr).toContain("DRY: echo hi");
    expect(sh(`DRY_RUN=0 outward echo hi`).stdout).toBe("hi\n");
  });

  it("run_to kills a command past its wall-clock limit", () => {
    const r = spawnSync("bash", ["-c", `. "${lib}"; run_to 1 sleep 5`], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });

  it("no evals/*.sh line calls gh/curl/npm/claude except through outward", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".sh")) files.push(p);
      }
    };
    walk(join(ROOT, "evals"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    // Outside heredoc bodies, comments and quoted strings, any gh/curl/npm/
    // claude word, and any node call of jira.mjs or a check-*.mjs, must come
    // after `outward` on its line (lib.sh's `api`/`jira` wrap it themselves).
    const OUTWARD_WORD = /(^|[^\w.$/-])(gh|curl|npm|claude)(?![\w.-])|node[^\n]*(jira\.mjs|check-[\w-]+\.mjs)/;
    const hits: string[] = [];
    for (const f of files) {
      let heredocEnd: string | null = null;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (heredocEnd !== null) {
            if (line.trim() === heredocEnd) heredocEnd = null;
            return;
          }
          const start = /<<-?\s*'?(\w+)'?/.exec(line);
          if (start) heredocEnd = start[1];
          const code = line
            .replace(/^\s*#.*$/, "")
            .replace(/\s#.*$/, "")
            .replace(/'[^']*'/g, "''")
            .replace(/"(?:[^"\\]|\\.)*"/g, '""');
          const m = OUTWARD_WORD.exec(code);
          if (m && !code.slice(0, m.index).includes("outward")) hits.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
    // The matcher is not a no-op.
    expect(OUTWARD_WORD.test("run_to 10 npm run loop")).toBe(true);
    expect(OUTWARD_WORD.test("x && gh pr close 1")).toBe(true);
    expect(OUTWARD_WORD.test("node evals/jira.mjs close K")).toBe(true);
    expect(OUTWARD_WORD.test('log "$GH_REPO"'.replace(/"(?:[^"\\]|\\.)*"/g, '""'))).toBe(false);
  });
});

describe("evals/report.mjs", () => {
  it("summarizes outcome, phases, cost and minutes per scenario", () => {
    const records = [
      {
        ticket: "TARS-1",
        session: "s1",
        loop_version: "2.0.0",
        started: "2026-11-12T10:00:00.000Z",
        ended: "2026-11-12T10:30:00.000Z",
        outcome: "landed",
        phases: [
          { role: "research", outcome: "landed", cost_usd: 4.5 },
          { role: "dev", outcome: "landed", cost_usd: 6 },
        ],
      },
      { ticket: "TARS-2", session: "s1", loop_version: "2.0.0", started: "x", ended: "y", outcome: "skipped-blocked", phases: [] },
    ];
    const rows = summarize(records, [
      { scenario: "clean", keys: ["TARS-1"] },
      { scenario: "blocked", keys: ["TARS-2"] },
    ]);
    expect(rows).toEqual([
      { scenario: "clean", ticket: "TARS-1", outcome: "landed", phases: "research:landed dev:landed", cost_usd: 10.5, minutes: 30 },
      { scenario: "blocked", ticket: "TARS-2", outcome: "skipped-blocked", phases: "", cost_usd: 0, minutes: null },
    ]);
  });
});
