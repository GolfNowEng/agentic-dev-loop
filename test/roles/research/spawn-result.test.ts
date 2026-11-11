import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { researchEarlySkillResult } from "../../../src/roles/research/spawn-result.ts";
import { runLoopIteration } from "../../../src/roles/research/phase.ts";
import type { SpawnClaudeResult } from "../../../src/core/spawn-claude.ts";
import type { JiraClient } from "../../../src/core/jira-client.ts";
import type { Config } from "../../../src/core/types.ts";
import { readRunLog } from "../../../src/core/runs-log.ts";

const config: Config = {
  jira: {
    triggerLabel: "pipeline:research",
    handoffLabel: "pipeline:dev",
    repoLabel: "repo:x",
    claimStatus: { from: "Backlog", to: "In Progress" },
    pollJql: { refine: 'labels = "{label}"', dev: 'labels = "{label}"' },
    statusNames: { bounced: "Blocked", prOpen: "Code Review" },
  },
  ceilings: { maxRunsPerDay: 100, maxCostPerRunUsd: 10, runTimeoutMin: 120 },
  autoPromoteLabel: "auto-promote",
  targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  github: { repo: "org/repo" },
};

const base = { skill: "ticket-refine", skillVersion: "abc", model: "sonnet" };

function spawnErrorRun(): SpawnClaudeResult {
  return {
    stdout: '{"type":"result","subtype":"error_max_budget_usd","total_cost_usd":12.3}',
    usage: { costUsd: 12.3, tokens: { in: 4000, out: 300 } },
    started: "2026-11-10T10:00:00.000Z",
    ended: "2026-11-10T10:20:00.000Z",
    spawnError: "claude exited with code 1. Output: ...",
    killedTimeout: false,
  };
}

describe("researchEarlySkillResult", () => {
  it("returns null for a clean run (the caller reads verdict.json)", () => {
    expect(researchEarlySkillResult({ ...spawnErrorRun(), spawnError: undefined }, base, 120)).toBeNull();
  });

  it("spawnError with parsed usage: v1's missing-verdict result, but the real cost and tokens", () => {
    const result = researchEarlySkillResult(spawnErrorRun(), base, 120)!;
    expect(result.verdictRaw).toBeUndefined();
    expect(result.costUsd).toBe(12.3);
    expect(result.tokens).toEqual({ in: 4000, out: 300 });
    expect(result.durationMin).toBe(20);
    expect(result.startedAt).toBe("2026-11-10T10:00:00.000Z");
  });

  it("killedTimeout: a killed / killed_ceiling verdict with the real cost", () => {
    const result = researchEarlySkillResult(
      { ...spawnErrorRun(), spawnError: undefined, killedTimeout: true },
      base,
      120,
    )!;
    expect(JSON.parse(result.verdictRaw!).outcome).toBe("killed");
    expect(result.costUsd).toBe(12.3);
  });

  it("end to end: runs.jsonl records cost_usd 12.3 and the post-run ceiling (maxCostPerRunUsd 10) pauses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "research-spawn-result-"));
    try {
      const runsLogPath = join(dir, "runs.jsonl");
      const jiraClient = {
        pollOldestMatching: vi.fn(async () => ({ key: "PROJ-1", status: "Backlog", assignee: "u", labels: [] })),
        pollAllMatching: vi.fn(async () => []),
        claimTicket: vi.fn(async () => true),
        transitionStatus: vi.fn(async () => {}),
        swapLabel: vi.fn(async () => {}),
        removeLabel: vi.fn(async () => {}),
        assignTicket: vi.fn(async () => {}),
        addComment: vi.fn(async () => {}),
        closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
      } as JiraClient;

      const result = await runLoopIteration({
        jiraClient,
        config,
        jql: 'labels = "pipeline:research"',
        runSkill: async () => researchEarlySkillResult(spawnErrorRun(), base, 120)!,
        runsLogPath,
        runsToday: 0,
        assigneeAccountId: "u",
      });

      const lines = await readRunLog(runsLogPath);
      expect(lines).toHaveLength(1);
      expect(lines[0].cost_usd).toBe(12.3);
      expect(lines[0].tokens).toEqual({ in: 4000, out: 300 });
      expect(lines[0].outcome).toBe("error");
      expect(lines[0].failure_category).toBe("agent_error");
      expect(result.action).toBe("paused-ceiling");
      expect(result.pauseReason).toMatch(/maxCostPerRunUsd/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
