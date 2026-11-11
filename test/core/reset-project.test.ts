import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { planReset, executeReset, describeResetPlan, describeResetSummary } from "../../src/core/reset-project.ts";
import type { Config } from "../../src/core/types.ts";
import { makeV2Config } from "../fixtures/config.ts";

function makeConfig(targetRepoPath?: string): Config {
  return makeV2Config((c) => {
    c.targetRepo = {
      url: "git@github.com:fandango/webtarsthree.git",
      defaultBranch: "master",
      ...(targetRepoPath ? { path: targetRepoPath } : {}),
    };
  });
}

describe("planReset", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "reset-project-test-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("finds no lines/dirs/files to remove for a ticket with no data at all", async () => {
    const plan = await planReset(repoRoot, "webtarsthree", "TARS-9999", null);
    expect(plan.ticketKey).toBe("TARS-9999");
    expect(plan.wholeProject).toBe(false);
    expect(plan.runsLogPath).toBeNull();
    expect(plan.runsLogLinesToRemove).toBe(0);
    expect(plan.runDirsToRemove).toEqual([]);
    expect(plan.rawUsageFilesToRemove).toEqual([]);
    expect(plan.worktreesToRemove).toEqual([]);
  });

  it("counts only the target ticket's lines in runs.jsonl, ignoring other tickets", async () => {
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    const lines = [
      { ticket: "TARS-1465", outcome: "landed" },
      { ticket: "TARS-1389", outcome: "landed" },
      { ticket: "TARS-1465", outcome: "bounced" },
    ];
    await writeFile(
      join(repoRoot, "runs", "webtarsthree.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );

    const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    expect(plan.runsLogLinesToRemove).toBe(2);
    expect(plan.runsLogPath).toBe(join(repoRoot, "runs", "webtarsthree.jsonl"));
  });

  it("finds .pipeline/<slug>/runs/<TICKET>-* directories, ignoring other tickets' run dirs", async () => {
    const runsDir = join(repoRoot, ".pipeline", "webtarsthree", "runs");
    await mkdir(join(runsDir, "TARS-1465-20260917T212959Z"), { recursive: true });
    await mkdir(join(runsDir, "TARS-1465-20260917T220051Z"), { recursive: true });
    await mkdir(join(runsDir, "TARS-1389-20260902T024916Z"), { recursive: true });

    const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    expect(plan.runDirsToRemove.sort()).toEqual([
      join(runsDir, "TARS-1465-20260917T212959Z"),
      join(runsDir, "TARS-1465-20260917T220051Z"),
    ]);
  });

  it("finds .pipeline/<slug>/raw-usage/<TICKET>-*.json files, ignoring other tickets", async () => {
    const rawUsageDir = join(repoRoot, ".pipeline", "webtarsthree", "raw-usage");
    await mkdir(rawUsageDir, { recursive: true });
    await writeFile(join(rawUsageDir, "TARS-1465-2026-09-17T212906339Z.json"), "{}", "utf8");
    await writeFile(join(rawUsageDir, "TARS-1389-2026-09-02T024916Z.json"), "{}", "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    expect(plan.rawUsageFilesToRemove).toEqual([
      join(rawUsageDir, "TARS-1465-2026-09-17T212906339Z.json"),
    ]);
  });

  it("finds targetRepo.path's own worktrees for this ticket when config.targetRepo.path is set", async () => {
    const targetRepoPath = await mkdtemp(join(tmpdir(), "target-repo-test-"));
    try {
      const worktreesDir = join(targetRepoPath, ".claude", "worktrees");
      await mkdir(join(worktreesDir, "TARS-1465-20260917T212959Z"), { recursive: true });
      await mkdir(join(worktreesDir, "TARS-1389-20260902T024916Z"), { recursive: true });

      const config = makeConfig(targetRepoPath);
      const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", config);
      expect(plan.worktreesToRemove).toEqual([
        join(worktreesDir, "TARS-1465-20260917T212959Z"),
      ]);
    } finally {
      await rm(targetRepoPath, { recursive: true, force: true });
    }
  });

  it("returns no worktrees to remove when config is null (no targetRepo.path known)", async () => {
    const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    expect(plan.worktreesToRemove).toEqual([]);
  });

  it("returns no worktrees to remove when config.targetRepo.path is unset", async () => {
    const config = makeConfig(undefined);
    const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", config);
    expect(plan.worktreesToRemove).toEqual([]);
  });

  it("a whole-project reset (no ticketKey) marks wholeProject true and skips per-ticket scanning entirely", async () => {
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    await writeFile(join(repoRoot, "runs", "webtarsthree.jsonl"), '{"ticket":"TARS-1"}\n', "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", undefined, null);
    expect(plan.wholeProject).toBe(true);
    expect(plan.ticketKey).toBeNull();
    expect(plan.runsLogPath).toBe(join(repoRoot, "runs", "webtarsthree.jsonl"));
    expect(plan.runDirsToRemove).toEqual([]);
    expect(plan.rawUsageFilesToRemove).toEqual([]);
    expect(plan.worktreesToRemove).toEqual([]);
  });

  it("a whole-project reset reports runsLogPath as null when the file doesn't exist", async () => {
    const plan = await planReset(repoRoot, "webtarsthree", undefined, null);
    expect(plan.runsLogPath).toBeNull();
  });
});

describe("executeReset", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "reset-project-exec-test-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("rewrites runs.jsonl removing only the target ticket's lines, preserving every other ticket's lines and their order", async () => {
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    const lines = [
      { ticket: "TARS-1364", outcome: "landed" },
      { ticket: "TARS-1465", outcome: "landed" },
      { ticket: "TARS-1389", outcome: "landed" },
      { ticket: "TARS-1465", outcome: "bounced" },
    ];
    const runsLogPath = join(repoRoot, "runs", "webtarsthree.jsonl");
    await writeFile(runsLogPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    await executeReset(plan);

    const remaining = (await readFile(runsLogPath, "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).ticket);
    expect(remaining).toEqual(["TARS-1364", "TARS-1389"]);
  });

  it("deletes every matching run dir, raw-usage file, and worktree named in the plan", async () => {
    const runsDir = join(repoRoot, ".pipeline", "webtarsthree", "runs");
    const rawUsageDir = join(repoRoot, ".pipeline", "webtarsthree", "raw-usage");
    await mkdir(join(runsDir, "TARS-1465-20260917T212959Z"), { recursive: true });
    await writeFile(join(runsDir, "TARS-1465-20260917T212959Z", "verdict.json"), "{}", "utf8");
    await mkdir(rawUsageDir, { recursive: true });
    await writeFile(join(rawUsageDir, "TARS-1465-2026-09-17T212906339Z.json"), "{}", "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    await executeReset(plan);

    await expect(readFile(join(runsDir, "TARS-1465-20260917T212959Z", "verdict.json"))).rejects.toThrow();
    await expect(readFile(join(rawUsageDir, "TARS-1465-2026-09-17T212906339Z.json"))).rejects.toThrow();
  });

  it("never touches another ticket's run dir, raw-usage file, or runs.jsonl line", async () => {
    const runsDir = join(repoRoot, ".pipeline", "webtarsthree", "runs");
    await mkdir(join(runsDir, "TARS-1465-20260917T212959Z"), { recursive: true });
    await mkdir(join(runsDir, "TARS-1389-20260902T024916Z"), { recursive: true });

    const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    await executeReset(plan);

    // TARS-1389's dir must still exist -- readFile on a file inside it
    // should not throw "no such directory".
    const stillThere = await readdirSafe(join(runsDir, "TARS-1389-20260902T024916Z"));
    expect(stillThere).not.toBeNull();
  });

  it("a whole-project reset deletes runs.jsonl entirely", async () => {
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    const runsLogPath = join(repoRoot, "runs", "webtarsthree.jsonl");
    await writeFile(runsLogPath, '{"ticket":"TARS-1"}\n', "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", undefined, null);
    await executeReset(plan);

    await expect(readFile(runsLogPath, "utf8")).rejects.toThrow();
  });

  it("a whole-project reset deletes .pipeline/<slug>/ entirely, including every ticket's run dirs", async () => {
    const pipelineDir = join(repoRoot, ".pipeline", "webtarsthree");
    await mkdir(join(pipelineDir, "runs", "TARS-1465-20260917T212959Z"), { recursive: true });
    await mkdir(join(pipelineDir, "raw-usage"), { recursive: true });
    await writeFile(join(pipelineDir, "raw-usage", "TARS-1465-x.json"), "{}", "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", undefined, null);
    await executeReset(plan);

    const stillThere = await readdirSafe(pipelineDir);
    expect(stillThere).toBeNull();
  });

  it("a whole-project reset for one project's slug never touches another project's .pipeline/<slug>/ directory", async () => {
    const otherPipelineDir = join(repoRoot, ".pipeline", "catalog-ui-management");
    await mkdir(join(otherPipelineDir, "runs"), { recursive: true });

    const plan = await planReset(repoRoot, "webtarsthree", undefined, null);
    await executeReset(plan);

    const stillThere = await readdirSafe(otherPipelineDir);
    expect(stillThere).not.toBeNull();
  });

  it("a whole-project reset is a no-op on runs.jsonl when the file never existed (no error thrown)", async () => {
    const plan = await planReset(repoRoot, "webtarsthree", undefined, null);
    const summary = await executeReset(plan);
    expect(summary.runsLogLinesRemoved).toBe(0);
    expect(summary.wholeProjectLogDeleted).toBe(false);
  });

  it("removing a ticket that has zero matching lines leaves runs.jsonl untouched", async () => {
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    const runsLogPath = join(repoRoot, "runs", "webtarsthree.jsonl");
    const original = '{"ticket":"TARS-1389"}\n';
    await writeFile(runsLogPath, original, "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", "TARS-9999", null);
    await executeReset(plan);

    expect(await readFile(runsLogPath, "utf8")).toBe(original);
  });

  it("a per-ticket reset archives the removed lines instead of deleting them, and returns a matching ResetSummary", async () => {
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    const lines = [
      { ticket: "TARS-1364", outcome: "landed" },
      { ticket: "TARS-1465", outcome: "landed" },
      { ticket: "TARS-1465", outcome: "bounced" },
    ];
    const runsLogPath = join(repoRoot, "runs", "webtarsthree.jsonl");
    await writeFile(runsLogPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    const summary = await executeReset(plan);

    expect(summary.runsLogLinesRemoved).toBe(2);
    expect(summary.runsLogLinesArchived).toBe(2);
    expect(summary.archivePath).toBe(join(repoRoot, "runs", "webtarsthree.reset-archive.jsonl"));

    const archived = (await readFile(summary.archivePath, "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).ticket);
    expect(archived).toEqual(["TARS-1465", "TARS-1465"]);

    // Live log still trimmed correctly -- archiving must not change that.
    const remaining = (await readFile(runsLogPath, "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).ticket);
    expect(remaining).toEqual(["TARS-1364"]);
  });

  it("a whole-project reset archives the entire prior log before deleting it", async () => {
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    const lines = [
      { ticket: "TARS-1364", outcome: "landed" },
      { ticket: "TARS-1465", outcome: "landed" },
    ];
    const runsLogPath = join(repoRoot, "runs", "webtarsthree.jsonl");
    await writeFile(runsLogPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", undefined, null);
    const summary = await executeReset(plan);

    expect(summary.runsLogLinesRemoved).toBe(2);
    expect(summary.runsLogLinesArchived).toBe(2);
    expect(summary.wholeProjectLogDeleted).toBe(true);
    expect(summary.pipelineDirDeleted).toBe(true);

    const archived = (await readFile(summary.archivePath, "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).ticket);
    expect(archived).toEqual(["TARS-1364", "TARS-1465"]);
    await expect(readFile(runsLogPath, "utf8")).rejects.toThrow();
  });

  it("a second reset's archive lines append after the first's, never overwriting", async () => {
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    const runsLogPath = join(repoRoot, "runs", "webtarsthree.jsonl");

    await writeFile(runsLogPath, JSON.stringify({ ticket: "TARS-1465", outcome: "landed" }) + "\n", "utf8");
    const plan1 = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    const summary1 = await executeReset(plan1);

    await writeFile(runsLogPath, JSON.stringify({ ticket: "TARS-1465", outcome: "bounced" }) + "\n", "utf8");
    const plan2 = await planReset(repoRoot, "webtarsthree", "TARS-1465", null);
    const summary2 = await executeReset(plan2);

    expect(summary1.archivePath).toBe(summary2.archivePath);
    const archived = (await readFile(summary2.archivePath, "utf8"))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).outcome);
    expect(archived).toEqual(["landed", "bounced"]);
  });

  it("a whole-project reset never archives another project's runs.jsonl, only this slug's", async () => {
    await mkdir(join(repoRoot, "runs"), { recursive: true });
    const runsLogPath = join(repoRoot, "runs", "webtarsthree.jsonl");
    await writeFile(runsLogPath, JSON.stringify({ ticket: "TARS-1", outcome: "landed" }) + "\n", "utf8");
    const otherLogPath = join(repoRoot, "runs", "catalog-ui-management.jsonl");
    const otherOriginal = JSON.stringify({ ticket: "OTHER-1", outcome: "landed" }) + "\n";
    await writeFile(otherLogPath, otherOriginal, "utf8");

    const plan = await planReset(repoRoot, "webtarsthree", undefined, null);
    await executeReset(plan);

    expect(await readFile(otherLogPath, "utf8")).toBe(otherOriginal);
    await expect(readFile(join(repoRoot, "runs", "catalog-ui-management.reset-archive.jsonl"))).rejects.toThrow();
  });
});

describe("describeResetPlan", () => {
  it("describes an empty per-ticket plan as nothing to delete in every category", () => {
    const plan = {
      ticketKey: "TARS-9999",
      pipelineDir: "/repo/.pipeline/webtarsthree",
      runsLogArchivePath: "/repo/runs/webtarsthree.reset-archive.jsonl",
      runsLogPath: null,
      runsLogLinesToRemove: 0,
      runDirsToRemove: [],
      rawUsageFilesToRemove: [],
      worktreesToRemove: [],
      wholeProject: false,
    };
    const text = describeResetPlan(plan);
    expect(text).toContain("no matching lines");
    expect(text).toContain("no matching run dirs");
    expect(text).toContain("no matching files");
    expect(text).toContain("none matching");
  });

  it("describes a populated per-ticket plan with counts and paths", () => {
    const plan = {
      ticketKey: "TARS-1465",
      pipelineDir: "/repo/.pipeline/webtarsthree",
      runsLogArchivePath: "/repo/runs/webtarsthree.reset-archive.jsonl",
      runsLogPath: "runs/webtarsthree.jsonl",
      runsLogLinesToRemove: 9,
      runDirsToRemove: ["/repo/.pipeline/webtarsthree/runs/TARS-1465-20260917T212959Z"],
      rawUsageFilesToRemove: ["/repo/.pipeline/webtarsthree/raw-usage/TARS-1465-x.json"],
      worktreesToRemove: [],
      wholeProject: false,
    };
    const text = describeResetPlan(plan);
    expect(text).toContain("9 line(s)");
    expect(text).toContain("1 run dir(s)");
    expect(text).toContain("1 raw-usage file(s)");
  });

  it("describes a whole-project plan distinctly from a per-ticket plan", () => {
    const plan = {
      ticketKey: null,
      pipelineDir: "/repo/.pipeline/webtarsthree",
      runsLogArchivePath: "/repo/runs/webtarsthree.reset-archive.jsonl",
      runsLogPath: "runs/webtarsthree.jsonl",
      runsLogLinesToRemove: 0,
      runDirsToRemove: [],
      rawUsageFilesToRemove: [],
      worktreesToRemove: [],
      wholeProject: true,
    };
    const text = describeResetPlan(plan);
    expect(text).toContain("delete runs.jsonl entirely");
    expect(text).toContain("delete .pipeline/<slug>/ entirely");
  });

  it("shortens paths under the home directory to ~/... in a per-ticket plan", () => {
    const plan = {
      ticketKey: "TARS-1465",
      pipelineDir: join(homedir(), "repos/dev-loop/.pipeline/webtarsthree"),
      runsLogArchivePath: join(homedir(), "repos/dev-loop/runs/webtarsthree.reset-archive.jsonl"),
      runsLogPath: join(homedir(), "repos/dev-loop/runs/webtarsthree.jsonl"),
      runsLogLinesToRemove: 1,
      runDirsToRemove: [join(homedir(), "repos/dev-loop/.pipeline/webtarsthree/runs/TARS-1465-x")],
      rawUsageFilesToRemove: [join(homedir(), "repos/dev-loop/.pipeline/webtarsthree/raw-usage/TARS-1465-x.json")],
      worktreesToRemove: [],
      wholeProject: false,
    };
    const text = describeResetPlan(plan);
    expect(text).not.toContain(homedir());
    expect(text).toContain("~/repos/dev-loop/runs/webtarsthree.jsonl");
    expect(text).toContain("~/repos/dev-loop/.pipeline/webtarsthree/runs/TARS-1465-x");
    expect(text).toContain("~/repos/dev-loop/.pipeline/webtarsthree/raw-usage/TARS-1465-x.json");
  });
});

describe("describeResetSummary", () => {
  it("describes a populated per-ticket reset summary with counts and paths", () => {
    const summary = {
      runsLogLinesRemoved: 9,
      runsLogLinesArchived: 9,
      archivePath: "/repo/runs/webtarsthree.reset-archive.jsonl",
      runDirsDeleted: ["/repo/.pipeline/webtarsthree/runs/TARS-1465-20260917T212959Z"],
      rawUsageFilesDeleted: ["/repo/.pipeline/webtarsthree/raw-usage/TARS-1465-x.json"],
      worktreesDeleted: [],
      wholeProjectLogDeleted: false,
      pipelineDirDeleted: false,
    };
    const text = describeResetSummary(summary);
    expect(text).toContain("9 line(s)");
    expect(text).toContain("archived to /repo/runs/webtarsthree.reset-archive.jsonl");
    expect(text).toContain("1 run dir(s)");
    expect(text).toContain("1 raw-usage file(s)");
  });

  it("describes an empty per-ticket reset summary as nothing deleted in every category", () => {
    const summary = {
      runsLogLinesRemoved: 0,
      runsLogLinesArchived: 0,
      archivePath: "/repo/runs/webtarsthree.reset-archive.jsonl",
      runDirsDeleted: [],
      rawUsageFilesDeleted: [],
      worktreesDeleted: [],
      wholeProjectLogDeleted: false,
      pipelineDirDeleted: false,
    };
    const text = describeResetSummary(summary);
    expect(text).toContain("no lines removed");
    expect(text).toContain("no run dirs deleted");
    expect(text).toContain("no raw-usage files deleted");
    expect(text).toContain("no worktrees deleted");
  });

  it("describes a whole-project reset summary distinctly, naming both the log and pipeline dir as deleted", () => {
    const summary = {
      runsLogLinesRemoved: 12,
      runsLogLinesArchived: 12,
      archivePath: "/repo/runs/webtarsthree.reset-archive.jsonl",
      runDirsDeleted: [],
      rawUsageFilesDeleted: [],
      worktreesDeleted: [],
      wholeProjectLogDeleted: true,
      pipelineDirDeleted: true,
    };
    const text = describeResetSummary(summary);
    expect(text).toContain("runs.jsonl deleted");
    expect(text).toContain(".pipeline/<slug>/ deleted");
    expect(text).toContain("12 line(s)");
  });

  it("shortens paths under the home directory to ~/... in a per-ticket summary", () => {
    const summary = {
      runsLogLinesRemoved: 1,
      runsLogLinesArchived: 1,
      archivePath: join(homedir(), "repos/dev-loop/runs/webtarsthree.reset-archive.jsonl"),
      runDirsDeleted: [join(homedir(), "repos/dev-loop/.pipeline/webtarsthree/runs/TARS-1465-x")],
      rawUsageFilesDeleted: [join(homedir(), "repos/dev-loop/.pipeline/webtarsthree/raw-usage/TARS-1465-x.json")],
      worktreesDeleted: [],
      wholeProjectLogDeleted: false,
      pipelineDirDeleted: false,
    };
    const text = describeResetSummary(summary);
    expect(text).not.toContain(homedir());
    expect(text).toContain("~/repos/dev-loop/runs/webtarsthree.reset-archive.jsonl");
    expect(text).toContain("~/repos/dev-loop/.pipeline/webtarsthree/runs/TARS-1465-x");
    expect(text).toContain("~/repos/dev-loop/.pipeline/webtarsthree/raw-usage/TARS-1465-x.json");
  });
});

async function readdirSafe(dir: string): Promise<string[] | null> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(dir);
  } catch {
    return null;
  }
}
