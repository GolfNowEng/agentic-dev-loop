// The real RunSkillFn over an injected spawn: the prompt it builds, where it
// spawns, what it creates, and where it reads the verdict (only
// RUN_DIR/verdict.json).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunSkill, type SkillRunnerDeps } from "../../src/worker/skill-runner.ts";
import type { SpawnClaudeOpts, SpawnClaudeResult } from "../../src/core/spawn-claude.ts";
import { resolveRepoPath, v2RunDir } from "../../src/core/paths.ts";
import { ALLOWED_TOOLS as DEV_TOOLS } from "../../src/roles/dev/tools.ts";
import { ALLOWED_TOOLS as RESEARCH_TOOLS } from "../../src/roles/research/tools.ts";
import { makeV2Config } from "../fixtures/config.ts";

const RID = "20261111T010203Z";
const SLUG = "skill-runner-test";

function okRun(): SpawnClaudeResult {
  return {
    stdout: JSON.stringify({ total_cost_usd: 1.5 }),
    usage: { costUsd: 1.5, tokens: { in: 10, out: 5 } },
    started: "2026-11-11T01:02:03.000Z",
    ended: "2026-11-11T01:12:03.000Z",
    killedTimeout: false,
  };
}

describe("makeRunSkill", () => {
  let repo: string;
  let spawned: SpawnClaudeOpts[];
  let onSpawn: (opts: SpawnClaudeOpts) => Promise<void>;
  let result: SpawnClaudeResult;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "skill-runner-repo-"));
    spawned = [];
    onSpawn = async () => {};
    result = okRun();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(resolveRepoPath(`.pipeline/v2/${SLUG}`), { recursive: true, force: true });
  });

  function deps(extra: Partial<SkillRunnerDeps> = {}): SkillRunnerDeps {
    return {
      config: makeV2Config((c) => {
        c.targetRepo.path = repo;
      }),
      slug: SLUG,
      repoRoot: "/abs/dev-loop",
      stream: false,
      researchStance: "# research stance\nbe skeptical",
      skillVersion: { research: "sha-r", dev: "sha-d" },
      spawn: async (opts) => {
        spawned.push(opts);
        await onSpawn(opts);
        return result;
      },
      log: () => {},
      logError: () => {},
      ...extra,
    };
  }

  const runDir = (role: "research" | "dev") => v2RunDir(SLUG, "dev-1", "TARS-1", role, RID);

  it("dev: prompt with absolute run-dir and repo-dir, cwd = repo root, no stance, add-dir = repo dir", async () => {
    await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    const [o] = spawned;
    expect(o.prompt).toBe(`/ticket-to-pr TARS-1 run-dir=${resolveRepoPath(runDir("dev"))} repo-dir=${repo}`);
    expect(o.cwd).toBe("/abs/dev-loop");
    expect(o.allowedTools).toBe(DEV_TOOLS);
    expect(o.addDir).toBe(repo);
    expect(o.excludeClaudeMd ?? []).toEqual([]);
    expect(o.appendSystemPrompt).toBeUndefined();
    expect(o.maxBudgetUsd).toBe(20);
    expect(o.timeoutMin).toBe(75);
    expect(o.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(String(75 * 60_000));
    expect(o.rawUsagePath).toBe(join(resolveRepoPath(runDir("dev")), "usage.json"));
  });

  it("research: same cwd, excludes the root CLAUDE.md and appends the research stance", async () => {
    await makeRunSkill(deps())({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
    const [o] = spawned;
    expect(o.prompt).toBe(`/ticket-refine TARS-1 run-dir=${resolveRepoPath(runDir("research"))} repo-dir=${repo}`);
    expect(o.cwd).toBe("/abs/dev-loop");
    expect(o.allowedTools).toBe(RESEARCH_TOOLS);
    expect(o.excludeClaudeMd).toEqual(["/abs/dev-loop/CLAUDE.md"]);
    expect(o.appendSystemPrompt).toBe("# research stance\nbe skeptical");
    expect(o.addDir).toBe(repo);
    expect(o.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(String(120 * 60_000));
  });

  it("no targetRepo.path: repo-dir is the absolute v2 clone dir and no --add-dir (it is inside the repo root)", async () => {
    const d = deps({ config: makeV2Config() });
    await makeRunSkill(d)({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(spawned[0].prompt).toMatch(new RegExp(`repo-dir=${resolveRepoPath(`.pipeline/v2/${SLUG}/repo`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    expect(spawned[0].addDir).toBeNull();
  });

  it("creates RUN_DIR before spawning", async () => {
    let existed = false;
    onSpawn = async (o) => {
      existed = (await stat(resolveRepoPath(runDir("dev")))).isDirectory();
      expect(o.prompt).toContain("run-dir=");
    };
    await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(existed).toBe(true);
  });

  it("reads RUN_DIR/verdict.json (redacted) and returns it with the measured usage", async () => {
    onSpawn = async () => {
      await writeFile(join(resolveRepoPath(runDir("dev")), "verdict.json"), '{"outcome":"landed","detail":"mail a@b.example"}', "utf8");
    };
    const r = await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(r.verdictRaw).toContain('"outcome":"landed"');
    expect(r.verdictRaw).not.toContain("a@b.example");
    expect(r).toMatchObject({ costUsd: 1.5, tokens: { in: 10, out: 5 }, skillVersion: "sha-d", model: "sonnet" });
  });

  it("never reads a verdict from anywhere else (no newest-run-dir discovery)", async () => {
    onSpawn = async () => {
      const other = resolveRepoPath(`.pipeline/v2/${SLUG}`);
      await mkdir(join(other, "elsewhere"), { recursive: true });
      await writeFile(join(other, "elsewhere", "verdict.json"), '{"outcome":"landed"}', "utf8");
    };
    const r = await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(r.verdictRaw).toBeUndefined();
  });

  it("a timeout kill returns the killed verdict without reading verdict.json", async () => {
    result = { ...okRun(), killedTimeout: true };
    onSpawn = async () => {
      await writeFile(join(resolveRepoPath(runDir("dev")), "verdict.json"), '{"outcome":"landed"}', "utf8");
    };
    const r = await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(JSON.parse(r.verdictRaw!).outcome).toBe("killed");
    expect(r.costUsd).toBe(1.5);
  });

  it("calls beforeRun for research only (the mirror Issue), before spawning", async () => {
    const order: string[] = [];
    const d = deps({ beforeRun: async (role, key) => void order.push(`before:${role}:${key}`) });
    onSpawn = async (o) => void order.push(`spawn:${o.prompt.split(" ")[0]}`);
    await makeRunSkill(d)({ role: "research", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 50 });
    await makeRunSkill(d)({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(order).toEqual(["before:research:TARS-1", "spawn:/ticket-refine", "spawn:/ticket-to-pr"]);
  });

  it("rejects a runDir that is not this ticket's and role's (never spawns)", async () => {
    const run = makeRunSkill(deps());
    await expect(run({ role: "dev", ticketKey: "TARS-1", runDir: runDir("research"), maxBudgetUsd: 20 })).rejects.toThrow();
    await expect(run({ role: "dev", ticketKey: "TARS-2", runDir: runDir("dev"), maxBudgetUsd: 20 })).rejects.toThrow();
    expect(spawned).toEqual([]);
  });

  it("raw usage lands in RUN_DIR/usage.json via the spawn's rawUsagePath (written by spawnClaudeRun)", async () => {
    onSpawn = async (o) => {
      await writeFile(o.rawUsagePath, "{}", "utf8");
    };
    await makeRunSkill(deps())({ role: "dev", ticketKey: "TARS-1", runDir: runDir("dev"), maxBudgetUsd: 20 });
    expect(await readFile(join(resolveRepoPath(runDir("dev")), "usage.json"), "utf8")).toBe("{}");
  });
});
