import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runLoopIteration } from "../src/loop-runner.js";
import type { RunSkillFn, RunSkillResult, RunLoopIterationDeps } from "../src/loop-runner.js";
import type { JiraClient, JiraTicket } from "../src/jira-client.js";
import type { Config } from "../src/types.js";
import { readRunLog } from "../src/runs-log.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function makeConfig(overrides: Partial<Config["ceilings"]> = {}): Config {
  return {
    jira: {
      intakeEpics: ["EPIC-1"],
      reviewEpic: "EPIC-REVIEW",
      readyEpic: "EPIC-READY",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: { refine: "epic in ({epics})", dev: "epic = {epic}" },
      epicLinkField: "customfield_10014",
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
    },
    ceilings: {
      maxRunsPerDay: 100,
      maxCostPerRunUsd: 50,
      runTimeoutMin: 60,
      ...overrides,
    },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}

function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return { key: "PROJ-142", status: "Backlog", epic: "EPIC-1", labels: [], ...overrides };
}

/** A JiraClient test double with every method mocked and inspectable. */
function makeMockJiraClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => makeTicket()),
    claim: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => undefined),
    moveToEpic: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeRunSkillResult(overrides: Partial<RunSkillResult> = {}): RunSkillResult {
  return {
    skill: "ticket-refine",
    skillVersion: "abc1234",
    model: "sonnet",
    startedAt: "2026-08-16T14:02:11Z",
    endedAt: "2026-08-16T14:19:40Z",
    verdictRaw: JSON.stringify({
      outcome: "landed",
      phase_reached: "pr",
      failure_category: null,
      detail: "Looks good.",
    }),
    durationMin: 5,
    costUsd: 1.0,
    ...overrides,
  };
}

describe("runLoopIteration", () => {
  let dir: string;
  let runsLogPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-runner-test-"));
    runsLogPath = path.join(dir, "runs.jsonl");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns empty-queue and never calls runSkill when nothing matches the poll", async () => {
    const jiraClient = makeMockJiraClient({
      pollOldestMatching: vi.fn(async () => null),
    });
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    const result = await runLoopIteration({
      jiraClient,
      config: makeConfig(),
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 0,
    });

    expect(result.action).toBe("empty-queue");
    expect(runSkill).not.toHaveBeenCalled();
  });

  it("claim-race: when claim() fails, the loop skips the ticket and does not throw", async () => {
    const jiraClient = makeMockJiraClient({
      pollOldestMatching: vi.fn(async () => makeTicket({ key: "PROJ-142" })),
      claim: vi.fn(async () => false), // simulates another process racing the transition
    });
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    let result;
    await expect(
      (async () => {
        result = await runLoopIteration({
          jiraClient,
          config: makeConfig(),
          jql: "epic in (EPIC-1)",
          runSkill,
          runsLogPath,
          runsToday: 0,
        });
      })(),
    ).resolves.not.toThrow();

    expect(result!.action).toBe("claim-raced");
    expect(runSkill).not.toHaveBeenCalled();
    // No run should have been logged for a skipped/raced ticket.
    const lines = await readRunLog(runsLogPath).catch(() => []);
    expect(lines).toHaveLength(0);
  });

  it("malformed verdict.json is treated as outcome error / failure_category agent_error", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({ verdictRaw: "{ not valid json ::" }),
    );

    const result = await runLoopIteration({
      jiraClient,
      config: makeConfig(),
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 0,
    });

    expect(result.action).toBe("processed");
    expect(result.logLine?.outcome).toBe("error");
    expect(result.logLine?.failure_category).toBe("agent_error");
  });

  it("missing verdict.json (undefined) is treated as outcome error / failure_category agent_error", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({ verdictRaw: undefined }),
    );

    const result = await runLoopIteration({
      jiraClient,
      config: makeConfig(),
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 0,
    });

    expect(result.action).toBe("processed");
    expect(result.logLine?.outcome).toBe("error");
    expect(result.logLine?.failure_category).toBe("agent_error");
  });

  it("ceiling breach (maxRunsPerDay) pauses the loop instead of continuing silently", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    const result = await runLoopIteration({
      jiraClient,
      config: makeConfig({ maxRunsPerDay: 1 }),
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 1, // already at the ceiling before this run
    });

    expect(result.action).toBe("paused-ceiling");
    expect(result.pauseReason).toBeTruthy();
  });

  it("ceiling breach (maxCostPerRunUsd) pauses the loop instead of continuing silently", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({ costUsd: 999 }),
    );

    const result = await runLoopIteration({
      jiraClient,
      config: makeConfig({ maxCostPerRunUsd: 5 }),
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 0,
    });

    expect(result.action).toBe("paused-ceiling");
    expect(result.pauseReason).toBeTruthy();
  });

  it("ceiling breach (runTimeoutMin) pauses the loop instead of continuing silently", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({ durationMin: 9999 }),
    );

    const result = await runLoopIteration({
      jiraClient,
      config: makeConfig({ runTimeoutMin: 30 }),
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 0,
    });

    expect(result.action).toBe("paused-ceiling");
    expect(result.pauseReason).toBeTruthy();
  });

  it("a passing verdict without autoPromoteLabel moves the ticket to the review epic", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({
        verdictRaw: JSON.stringify({
          outcome: "landed",
          phase_reached: "pr",
          failure_category: null,
          detail: "Refined and ready for human review.",
        }),
      }),
    );
    const config = makeConfig();

    await runLoopIteration({
      jiraClient,
      config,
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 0,
    });

    expect(jiraClient.moveToEpic).toHaveBeenCalledWith("PROJ-142", config.jira.reviewEpic);
  });

  it("a passing verdict with autoPromoteLabel present moves the ticket to the ready epic", async () => {
    const jiraClient = makeMockJiraClient({
      pollOldestMatching: vi.fn(async () =>
        makeTicket({ key: "PROJ-142", labels: ["auto-promote"] }),
      ),
    });
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({
        verdictRaw: JSON.stringify({
          outcome: "landed",
          phase_reached: "pr",
          failure_category: null,
          detail: "Refined; auto-promoted.",
        }),
      }),
    );
    const config = makeConfig();

    await runLoopIteration({
      jiraClient,
      config,
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 0,
    });

    expect(jiraClient.moveToEpic).toHaveBeenCalledWith("PROJ-142", config.jira.readyEpic);
  });

  it("a bounced verdict sets status bounced and does not move the ticket's epic", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({
        verdictRaw: JSON.stringify({
          outcome: "bounced",
          phase_reached: "verify",
          failure_category: "verify_rejected",
          detail: "Verification rejected the change.",
        }),
      }),
    );
    const config = makeConfig();

    const result = await runLoopIteration({
      jiraClient,
      config,
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 0,
    });

    expect(result.logLine?.outcome).toBe("bounced");
    expect(jiraClient.moveToEpic).not.toHaveBeenCalled();
  });

  it("appends exactly one valid runs.jsonl line for a processed ticket", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    await runLoopIteration({
      jiraClient,
      config: makeConfig(),
      jql: "epic in (EPIC-1)",
      runSkill,
      runsLogPath,
      runsToday: 0,
    });

    const lines = await readRunLog(runsLogPath);
    expect(lines).toHaveLength(1);
    expect(lines[0].ticket).toBe("PROJ-142");
    expect(lines[0].outcome).toBe("landed");
  });
});
