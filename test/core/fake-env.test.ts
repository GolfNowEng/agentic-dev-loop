// The loop's fake .envrc for the robot: parsed from the committed
// .envrc.example, every value single-quoted and literal. Temp dirs and fake
// values only; no real env file is ever read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_ENV_MARKER, ROBOT_ENV_VAR, fakeEnvPaths, parseEnvExample, renderFakeEnvrc, writeFakeEnv, type FakeEnvDeps } from "../../src/core/fake-env.ts";

describe("parseEnvExample", () => {
  it("keeps export lines, unwraps matching quotes, keeps $(...) literal", () => {
    const text = [
      "# header",
      "export A=x",
      '  export B="two words"',
      "export C='q'",
      "# export D=1",
      "",
      "FOO=bar",
      "export E=$(echo pwned)",
      "export F=http://localhost:5001/x?y=1  ",
    ].join("\n");
    expect(parseEnvExample(text)).toEqual([
      ["A", "x"],
      ["B", "two words"],
      ["C", "q"],
      ["E", "$(echo pwned)"],
      ["F", "http://localhost:5001/x?y=1"],
    ]);
  });

  it("drops a trailing comment outside quotes, and never overrides names that change how commands run", () => {
    const text = 'export A="a" # note\nexport B=b # note\nexport C="x # y"\nexport PATH=$PATH:./bin\nexport NODE_OPTIONS=--x\nexport LD_PRELOAD=x\nexport DIRENV_DIR=x\nexport HOME=/x';
    expect(parseEnvExample(text)).toEqual([["A", "a"], ["B", "b"], ["C", "x # y"]]);
  });

  it("skips a name that is not a plain identifier", () => {
    expect(parseEnvExample("export 1A=x\nexport A-B=y\nexport OK_1=z")).toEqual([["OK_1", "z"]]);
  });
});

describe("renderFakeEnvrc", () => {
  it("a person (no DEVLOOP_ROBOT_ENV) gets the real .envrc when it exists", () => {
    const out = renderFakeEnvrc([["A", "x"]], "/r/it's");
    expect(out).toContain(`if [ -z "\${${ROBOT_ENV_VAR}:-}" ] && [ -f '/r/it'\\''s/.envrc' ]; then`);
    expect(out).toContain("  source_env '/r/it'\\''s/.envrc'\n  return 0\nfi\n");
    expect(out.indexOf("source_env")).toBeLessThan(out.indexOf("export A="));
  });

  it("starts with the marker, single-quotes every value, ends with a newline", () => {
    const out = renderFakeEnvrc([["A", "x"], ["B", "it's"], ["C", "$(echo pwned)"]], "/r");
    expect(out.split("\n")[0]).toBe(FAKE_ENV_MARKER);
    expect(out).toContain("export A='x'\n");
    expect(out).toContain("export B='it'\\''s'\n");
    expect(out).toContain("export C='$(echo pwned)'\n");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("an empty list is the marker only", () => {
    expect(renderFakeEnvrc([], "/r").startsWith(`${FAKE_ENV_MARKER}\n`)).toBe(true);
    expect(renderFakeEnvrc([], "/r")).not.toContain("export ");
  });
});

describe("writeFakeEnv", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "fake-env-"));
    await mkdir(join(repo, ".git"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function deps(over: Partial<FakeEnvDeps> = {}) {
    const calls: { git: [string[], string][]; allow: string[] } = { git: [], allow: [] };
    const d: FakeEnvDeps = {
      git: async (args, cwd) => {
        calls.git.push([args, cwd]);
        return "export A=placeholder\nexport B=two\n";
      },
      direnvAllow: async (p) => {
        calls.allow.push(p);
      },
      ...over,
    };
    return { d, calls };
  }

  it("paths sit in <repo>/.claude/worktrees", () => {
    expect(fakeEnvPaths("/r")).toEqual({ envrc: "/r/.claude/worktrees/.envrc" });
  });

  it("writes the fake from origin's example, then allows it", async () => {
    const { d, calls } = deps();
    const r = await writeFakeEnv(repo, "master", d);
    expect(r).toEqual({ names: ["A", "B"], allowed: true, skipped: false });
    expect(calls.git).toEqual([[["show", "origin/master:.envrc.example"], repo]]);
    const p = fakeEnvPaths(repo);
    expect(await readFile(p.envrc, "utf8")).toBe(renderFakeEnvrc([["A", "placeholder"], ["B", "two"]], repo));
    expect(calls.allow).toEqual([p.envrc]);
  });

  it("git failing (no example on origin) gives a marker-only fake, never a throw", async () => {
    const { d } = deps({ git: async () => { throw new Error("fatal: path not in origin/master"); } });
    const r = await writeFakeEnv(repo, "master", d);
    expect(r.names).toEqual([]);
    expect(await readFile(fakeEnvPaths(repo).envrc, "utf8")).toBe(renderFakeEnvrc([], repo));
  });

  it("direnv missing: files still written, allowed false", async () => {
    const { d } = deps({ direnvAllow: async () => { throw new Error("spawn direnv ENOENT"); } });
    const r = await writeFakeEnv(repo, "master", d);
    expect(r.allowed).toBe(false);
    expect(await readFile(fakeEnvPaths(repo).envrc, "utf8")).toContain("export A=");
  });

  it("a repo dir with no .git yet (never cloned) is left alone, so a later git clone still works", async () => {
    const fresh = join(repo, "not-cloned");
    const { d, calls } = deps();
    expect(await writeFakeEnv(fresh, "master", d)).toEqual({ names: [], allowed: false, skipped: true });
    expect(existsSync(fresh)).toBe(false);
    expect(calls.git).toEqual([]);
  });

  it("unchanged content is not rewritten but is allowed again", async () => {
    const { d, calls } = deps();
    await writeFakeEnv(repo, "master", d);
    const before = (await stat(fakeEnvPaths(repo).envrc)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await writeFakeEnv(repo, "master", d);
    expect((await stat(fakeEnvPaths(repo).envrc)).mtimeMs).toBe(before);
    expect(calls.allow).toHaveLength(2);
  });
});

describe("rootEnvFiles", () => {
  it("skips a name that can't go into a deny rule (space, colon) and *.example", async () => {
    const { rootEnvFiles } = await import("../../src/core/env-files.ts");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const d = mkdtempSync(join(tmpdir(), "env-files-"));
    try {
      for (const n of [".env.local copy", ".env:x", ".env", ".envrc.example"]) writeFileSync(join(d, n), "x");
      expect(rootEnvFiles(d)).toEqual([".env"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("fakeEnvSummary", () => {
  it("names the count, or why there is no fake yet (never values)", async () => {
    const { fakeEnvSummary } = await import("../../src/core/fake-env.ts");
    expect(fakeEnvSummary({ names: ["A", "B"], allowed: true, skipped: false })).toBe("robot env: 2 fake setting(s) from .envrc.example");
    expect(fakeEnvSummary({ names: [], allowed: false, skipped: true })).toBe("robot env: repo not cloned yet; the fake is written on the first run after the clone");
    expect(fakeEnvSummary({ names: ["A"], allowed: false, skipped: false })).toBe("robot env: 1 fake setting(s) from .envrc.example (direnv allow failed; is direnv installed?)");
  });
});
