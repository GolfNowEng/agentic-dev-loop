import { describe, expect, it, vi } from "vitest";
import { runLoopIteration } from "../src/loop-runner.js";
import type { RunSkillFn, LoopIterationDeps } from "../src/loop-runner.js";
import type { JiraClient, JiraTicket } from "../src/jira-client.js";
import type { Config, Verdict } from "../src/types.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeConfig(): Config {
  return {
    jira: {
      intakeEpics: ["EPIC-1"],
      reviewEpic: "EPIC-REVIEW",
      readyEpic: "EPIC-READY",
      claimStatus: { from: "Ready", to: "In Progress" },
      pollJql: {
        refine: 'epic in ({epics}) ORDER BY created ASC',
        dev: 'epic = {readyEpic} ORDER BY created ASC',
      },
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
  };
}

function makeMockJiraClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => null),
    claimTicket: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => {}),
    moveToEpic: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    outcome: "landed",
    phase_reached: "pr",
    failure_category: null,
    detail: "Implemented cleanly.",
    red_confirmed: true,
    verify_loops: 1,
    retries: 0,
    skill_version: "abc1234",
    model: "sonnet",
    pr: "https://github.com/org/repo/pull/1",
    cost_usd: 1.0,
    tokens: { in: 1000, out: 100 },
    ...overrides,
  };
}

async function withTempRunsLog<T>(
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "loop-runner-test-"));
  const path = join(dir, "runs.jsonl");
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runLoopIteration", () => {
  it("returns idle when polling finds no matching ticket, without claiming or running the skill", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => null),
      });
      const runSkill: RunSkillFn = vi.fn();

      const deps: LoopIterationDeps = {
        jiraClient,
        config: makeConfig(),
        runSkill,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
      };

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("idle");
      expect(jiraClient.claimTicket).not.toHaveBeenCalled();
      expect(runSkill).not.toHaveBeenCalled();
    });
  });

  it("claim race: when claimTicket resolves false (another process raced it), the loop skips this ticket and continues without throwing", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket: JiraTicket = { key: "PROJ-1", status: "Ready", epic: "EPIC-READY" };
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        claimTicket: vi.fn(async () => false),
      });
      const runSkill: RunSkillFn = vi.fn();

      const deps: LoopIterationDeps = {
        jiraClient,
        config: makeConfig(),
        runSkill,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
      };

      let result;
      await expect(
        (async () => {
          result = await runLoopIteration(deps);
        })(),
      ).resolves.not.toThrow();

      expect(result!.kind).toBe("skipped-race");
      if (result!.kind === "skipped-race") {
        expect(result!.ticket).toBe("PROJ-1");
      }
      // Never spawns the skill for a ticket it failed to claim.
      expect(runSkill).not.toHaveBeenCalled();
    });
  });

  it("malformed/missing verdict.json is treated as outcome error / failure_category agent_error and still logged", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket: JiraTicket = { key: "PROJ-2", status: "Ready", epic: "EPIC-READY" };
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        claimTicket: vi.fn(async () => true),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "error",
          failure_category: "agent_error",
          detail: "verdict.json was missing or malformed",
        }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:05:00Z",
      }));

      const deps: LoopIterationDeps = {
        jiraClient,
        config: makeConfig(),
        runSkill,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
      };

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("ran");
      if (result.kind === "ran") {
        expect(result.logLine.outcome).toBe("error");
        expect(result.logLine.failure_category).toBe("agent_error");
      }

      const raw = await readFile(runsLogPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.outcome).toBe("error");
      expect(parsed.failure_category).toBe("agent_error");

      // An error outcome must not move the ticket's epic.
      expect(jiraClient.moveToEpic).not.toHaveBeenCalled();
    });
  });

  it("ceiling breach (runs/day) pauses the loop rather than silently continuing", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket: JiraTicket = { key: "PROJ-3", status: "Ready", epic: "EPIC-READY" };
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        claimTicket: vi.fn(async () => true),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:05:00Z",
      }));

      const config = makeConfig();
      const deps: LoopIterationDeps = {
        jiraClient,
        config,
        runSkill,
        loopKind: "dev",
        runsLogPath,
        // Already at the ceiling before this run even started.
        runsToday: config.ceilings.maxRunsPerDay,
      };

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("paused");
      if (result.kind === "paused") {
        expect(result.reason).toBeTruthy();
      }
    });
  });

  it("ceiling breach (cost/run) pauses the loop rather than silently continuing", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket: JiraTicket = { key: "PROJ-4", status: "Ready", epic: "EPIC-READY" };
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        claimTicket: vi.fn(async () => true),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ cost_usd: config.ceilings.maxCostPerRunUsd + 1 }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:05:00Z",
      }));

      const deps: LoopIterationDeps = {
        jiraClient,
        config,
        runSkill,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
      };

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("paused");
    });
  });

  it("ceiling breach (run timeout) pauses the loop rather than silently continuing", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket: JiraTicket = { key: "PROJ-5", status: "Ready", epic: "EPIC-READY" };
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        claimTicket: vi.fn(async () => true),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        // Timeout is 30 min; make this run take much longer.
        started: "2026-08-16T14:00:00Z",
        ended: "2026-08-16T15:30:00Z",
      }));

      const deps: LoopIterationDeps = {
        jiraClient,
        config,
        runSkill,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
      };

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("paused");
    });
  });

  it("epic-move-on-verdict: a landed verdict from the dev loop moves the ticket to the review epic", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket: JiraTicket = { key: "PROJ-6", status: "Ready", epic: "EPIC-READY" };
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        claimTicket: vi.fn(async () => true),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed" }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
      }));

      const deps: LoopIterationDeps = {
        jiraClient,
        config,
        runSkill,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
      };

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("ran");
      expect(jiraClient.moveToEpic).toHaveBeenCalledWith(
        "PROJ-6",
        config.jira.reviewEpic,
      );
    });
  });

  it("epic-move-on-verdict: a bounced verdict sets outcome bounced and does not move the epic", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket: JiraTicket = { key: "PROJ-7", status: "Ready", epic: "EPIC-READY" };
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        claimTicket: vi.fn(async () => true),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "bounced",
          failure_category: "spec_ambiguous",
          detail: "Acceptance criteria conflict with existing behavior.",
        }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
      }));

      const deps: LoopIterationDeps = {
        jiraClient,
        config,
        runSkill,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
      };

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("ran");
      if (result.kind === "ran") {
        expect(result.logLine.outcome).toBe("bounced");
      }
      expect(jiraClient.moveToEpic).not.toHaveBeenCalled();
    });
  });

  it("appends exactly one valid runs.jsonl line per run, matching the schema", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket: JiraTicket = { key: "PROJ-8", status: "Ready", epic: "EPIC-READY" };
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        claimTicket: vi.fn(async () => true),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
      }));

      const deps: LoopIterationDeps = {
        jiraClient,
        config: makeConfig(),
        runSkill,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
      };

      await runLoopIteration(deps);

      const raw = await readFile(runsLogPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.ticket).toBe("PROJ-8");
      expect(typeof parsed.started).toBe("string");
      expect(typeof parsed.ended).toBe("string");
      expect(["landed", "bounced", "error", "killed"]).toContain(
        parsed.outcome,
      );
    });
  });

  it("never touches a real JiraClient implementation or a real process - only the injected mocks are called", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket: JiraTicket = { key: "PROJ-9", status: "Ready", epic: "EPIC-READY" };
      const pollOldestMatching = vi.fn(async () => ticket);
      const claimTicket = vi.fn(async () => true);
      const transitionStatus = vi.fn(async () => {});
      const moveToEpic = vi.fn(async () => {});
      const jiraClient: JiraClient = {
        pollOldestMatching,
        claimTicket,
        transitionStatus,
        moveToEpic,
      };
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
      }));

      const deps: LoopIterationDeps = {
        jiraClient,
        config: makeConfig(),
        runSkill,
        loopKind: "dev",
        runsLogPath,
        runsToday: 0,
      };

      await runLoopIteration(deps);

      expect(pollOldestMatching).toHaveBeenCalled();
      expect(claimTicket).toHaveBeenCalled();
      expect(runSkill).toHaveBeenCalledWith("PROJ-9");
    });
  });
});
