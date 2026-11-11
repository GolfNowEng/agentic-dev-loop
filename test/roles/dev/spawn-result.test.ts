import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devEarlySkillResult } from "../../../src/roles/dev/spawn-result.ts";
import { runLoopIteration } from "../../../src/roles/dev/phase.ts";
import type { SpawnClaudeResult } from "../../../src/core/spawn-claude.ts";
import type { JiraClient } from "../../../src/core/jira-client.ts";
import type { GitHubClient } from "../../../src/core/github-client.ts";
import type { Config } from "../../../src/core/types.ts";

const config: Config = {
  jira: {
    triggerLabel: "pipeline:dev",
    handoffLabel: "pipeline:dev",
    repoLabel: "repo:x",
    claimStatus: { from: "Ready", to: "In Progress" },
    pollJql: { refine: 'labels = "{label}"', dev: 'labels = "{label}"' },
    statusNames: { bounced: "Blocked", prOpen: "Code Review" },
    codeReviewFields: { piiField: "f1", piiNoImpactOptionId: "o1", qaNotesField: "f2" },
  },
  ceilings: { maxRunsPerDay: 100, maxCostPerRunUsd: 10, runTimeoutMin: 75 },
  autoPromoteLabel: "auto-promote",
  targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  github: { repo: "org/repo" },
};

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

describe("devEarlySkillResult", () => {
  it("returns null for a clean run (the caller reads verdict.json)", () => {
    const run = { ...spawnErrorRun(), spawnError: undefined };
    expect(devEarlySkillResult(run, 75)).toBeNull();
  });

  it("spawnError with parsed usage: v1's agent_error verdict, but the real cost and tokens", () => {
    const result = devEarlySkillResult(spawnErrorRun(), 75)!;
    expect(result.verdict.outcome).toBe("error");
    expect(result.verdict.failure_category).toBe("agent_error");
    expect(result.costUsd).toBe(12.3);
    expect(result.tokens).toEqual({ in: 4000, out: 300 });
  });

  it("killedTimeout: outcome killed / killed_ceiling with the real cost", () => {
    const result = devEarlySkillResult({ ...spawnErrorRun(), spawnError: undefined, killedTimeout: true }, 75)!;
    expect(result.verdict.outcome).toBe("killed");
    expect(result.verdict.failure_category).toBe("killed_ceiling");
    expect(result.costUsd).toBe(12.3);
  });

  it("end to end: runs.jsonl records cost_usd 12.3 and the post-run ceiling (maxCostPerRunUsd 10) pauses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-spawn-result-"));
    try {
      const runsLogPath = join(dir, "runs.jsonl");
      const jiraClient = {
        pollOldestMatching: vi.fn(async () => ({ key: "PROJ-1", status: "In Progress", assignee: "u", labels: [] })),
        pollAllMatching: vi.fn(async () => []),
        claimTicket: vi.fn(async () => true),
        transitionStatus: vi.fn(async () => {}),
        swapLabel: vi.fn(async () => {}),
        removeLabel: vi.fn(async () => {}),
        assignTicket: vi.fn(async () => {}),
        addComment: vi.fn(async () => {}),
        closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
      } as JiraClient;
      const githubClient = {
        findIssueByJiraKey: vi.fn(async () => null),
        createIssue: vi.fn(),
        addComment: vi.fn(async () => {}),
        closeIssue: vi.fn(async () => {}),
        closePr: vi.fn(async () => "already-closed" as const),
      } as unknown as GitHubClient;

      const result = await runLoopIteration({
        jiraClient,
        githubClient,
        config,
        runSkill: async () => devEarlySkillResult(spawnErrorRun(), 75)!,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
        assigneeAccountId: "u",
        execGhPrView: vi.fn(async () => {
          throw new Error("unused");
        }),
      });

      const line = JSON.parse((await readFile(runsLogPath, "utf8")).trim());
      expect(line.cost_usd).toBe(12.3);
      expect(line.tokens).toEqual({ in: 4000, out: 300 });
      expect(line.outcome).toBe("error");
      expect(line.failure_category).toBe("agent_error");
      expect(result.kind).toBe("paused");
      if (result.kind === "paused") expect(result.reason).toMatch(/maxCostPerRunUsd/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
