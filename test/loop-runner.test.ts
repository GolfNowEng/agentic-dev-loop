import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runLoopIteration } from "../src/loop-runner.ts";
import type { RunSkillFn, RunSkillResult, RunLoopIterationDeps, LoopIterationResult } from "../src/loop-runner.ts";
import type { JiraClient, JiraTicket } from "../src/jira-client.ts";
import type { Config } from "../src/types.ts";
import { readRunLog } from "../src/runs-log.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ASSIGNEE_ACCOUNT_ID = "user-123";

function makeConfig(overrides: Partial<Config["ceilings"]> = {}): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: { refine: 'labels = "{label}"', dev: 'labels = "{label}"' },
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

/** Ticket already assigned to the configured human -- the common case in most tests below. */
function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return {
    key: "PROJ-142",
    status: "Backlog",
    labels: [],
    assignee: ASSIGNEE_ACCOUNT_ID,
    ...overrides,
  };
}

/** A JiraClient test double with every method mocked and inspectable. */
function makeMockJiraClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => makeTicket()),
    claim: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => undefined),
    swapLabel: vi.fn(async () => undefined),
    assignTicket: vi.fn(async () => undefined),
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
    // Deliberately different from any verdict.tokens value used in these
    // tests, so a test asserting on this exposes a bug that reads
    // verdict.tokens instead of the measured value.
    tokens: { in: 1234, out: 567 },
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

  function makeDeps(overrides: Partial<RunLoopIterationDeps> = {}): RunLoopIterationDeps {
    return {
      jiraClient: makeMockJiraClient(),
      config: makeConfig(),
      jql: "epic in (EPIC-1)",
      runSkill: vi.fn(async () => makeRunSkillResult()),
      runsLogPath,
      runsToday: 0,
      assigneeAccountId: ASSIGNEE_ACCOUNT_ID,
      ...overrides,
    };
  }

  it("returns empty-queue and never calls runSkill when nothing matches the poll", async () => {
    const jiraClient = makeMockJiraClient({
      pollOldestMatching: vi.fn(async () => null),
    });
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    const result = await runLoopIteration(makeDeps({ jiraClient, runSkill }));

    expect(result.action).toBe("empty-queue");
    expect(runSkill).not.toHaveBeenCalled();
    expect(jiraClient.assignTicket).not.toHaveBeenCalled();
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
        result = await runLoopIteration(makeDeps({ jiraClient, runSkill }));
      })(),
    ).resolves.not.toThrow();

    expect(result!.action).toBe("claim-raced");
    expect(runSkill).not.toHaveBeenCalled();
    // No run should have been logged for a skipped/raced ticket.
    const lines = await readRunLog(runsLogPath).catch(() => []);
    expect(lines).toHaveLength(0);
  });

  it("assigns the ticket to the configured human when it's currently unassigned", async () => {
    const jiraClient = makeMockJiraClient({
      pollOldestMatching: vi.fn(async () => makeTicket({ key: "PROJ-142", assignee: null })),
    });
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    await runLoopIteration(makeDeps({ jiraClient, runSkill }));

    expect(jiraClient.assignTicket).toHaveBeenCalledWith("PROJ-142", ASSIGNEE_ACCOUNT_ID);
  });

  it("does not call assignTicket when the ticket already has an assignee", async () => {
    const jiraClient = makeMockJiraClient({
      pollOldestMatching: vi.fn(async () =>
        makeTicket({ key: "PROJ-142", assignee: "someone-else" }),
      ),
    });
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    await runLoopIteration(makeDeps({ jiraClient, runSkill }));

    expect(jiraClient.assignTicket).not.toHaveBeenCalled();
  });

  it("an assignTicket failure never throws out of runLoopIteration -- the run still proceeds and completes, surfaced via jiraSyncError", async () => {
    const jiraClient = makeMockJiraClient({
      pollOldestMatching: vi.fn(async () => makeTicket({ key: "PROJ-142", assignee: null })),
      assignTicket: vi.fn(async () => {
        throw new Error("PUT ... -> 400 Bad Request");
      }),
    });
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    let result: LoopIterationResult | undefined;
    await expect(
      (async () => {
        result = await runLoopIteration(makeDeps({ jiraClient, runSkill }));
      })(),
    ).resolves.not.toThrow();

    expect(runSkill).toHaveBeenCalled();
    expect(result!.action).toBe("processed");
    expect(result!.jiraSyncError).toMatch(/400 Bad Request/);
  });

  it("malformed verdict.json is treated as outcome error / failure_category agent_error", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({ verdictRaw: "{ not valid json ::" }),
    );

    const result = await runLoopIteration(makeDeps({ jiraClient, runSkill }));

    expect(result.action).toBe("processed");
    expect(result.logLine?.outcome).toBe("error");
    expect(result.logLine?.failure_category).toBe("agent_error");
  });

  it("missing verdict.json (undefined) is treated as outcome error / failure_category agent_error", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({ verdictRaw: undefined }),
    );

    const result = await runLoopIteration(makeDeps({ jiraClient, runSkill }));

    expect(result.action).toBe("processed");
    expect(result.logLine?.outcome).toBe("error");
    expect(result.logLine?.failure_category).toBe("agent_error");
  });

  it("ceiling breach (maxRunsPerDay) pauses the loop instead of continuing silently", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    const result = await runLoopIteration(
      makeDeps({
        jiraClient,
        config: makeConfig({ maxRunsPerDay: 1 }),
        runSkill,
        runsToday: 1, // already at the ceiling before this run
      }),
    );

    expect(result.action).toBe("paused-ceiling");
    expect(result.pauseReason).toBeTruthy();
  });

  it("ceiling breach (maxCostPerRunUsd) pauses the loop instead of continuing silently", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({ costUsd: 999 }),
    );

    const result = await runLoopIteration(
      makeDeps({ jiraClient, config: makeConfig({ maxCostPerRunUsd: 5 }), runSkill }),
    );

    expect(result.action).toBe("paused-ceiling");
    expect(result.pauseReason).toBeTruthy();
  });

  it("a post-run ceiling breach still records the run's real consequences (runs.jsonl) before pausing -- a completed, valid verdict must never be silently discarded", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({
        costUsd: 999, // breaches maxCostPerRunUsd, but only known AFTER the run completed
        verdictRaw: JSON.stringify({
          outcome: "landed",
          phase_reached: "pr",
          failure_category: null,
          detail: "Refined and ready for human review.",
        }),
      }),
    );
    const config = makeConfig({ maxCostPerRunUsd: 5 });

    const result = await runLoopIteration(makeDeps({ jiraClient, config, runSkill }));

    expect(result.action).toBe("paused-ceiling");
    // The verdict was real and passing -- its consequences must still happen,
    // not be thrown away just because the ceiling was breached after the fact.
    // No autoPromoteLabel -- ticket stays in place, no epic move.
    expect(jiraClient.swapLabel).not.toHaveBeenCalled();
    const lines = await readRunLog(runsLogPath);
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("landed");
    expect(result.logLine?.outcome).toBe("landed");
  });

  it("ceiling breach (runTimeoutMin) pauses the loop instead of continuing silently", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({ durationMin: 9999 }),
    );

    const result = await runLoopIteration(
      makeDeps({ jiraClient, config: makeConfig({ runTimeoutMin: 30 }), runSkill }),
    );

    expect(result.action).toBe("paused-ceiling");
    expect(result.pauseReason).toBeTruthy();
  });

  it("a passing verdict without autoPromoteLabel never swaps the label -- the ticket stays at triggerLabel, refined, awaiting human approval", async () => {
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

    await runLoopIteration(makeDeps({ jiraClient, config, runSkill }));

    expect(jiraClient.swapLabel).not.toHaveBeenCalled();
  });

  it("a passing verdict with autoPromoteLabel present swaps triggerLabel to handoffLabel", async () => {
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

    await runLoopIteration(makeDeps({ jiraClient, config, runSkill }));

    expect(jiraClient.swapLabel).toHaveBeenCalledWith(
      "PROJ-142",
      config.jira.triggerLabel,
      config.jira.handoffLabel,
    );
  });

  it("a verdict with outcome \"ready\" (ticket-refine's own passing outcome) logs as \"landed\" and, without autoPromoteLabel, never moves the epic", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({
        verdictRaw: JSON.stringify({
          outcome: "ready",
          phase_reached: "verify",
          failure_category: null,
          detail: "Refined ticket written.",
        }),
      }),
    );
    const config = makeConfig();

    const result = await runLoopIteration(makeDeps({ jiraClient, config, runSkill }));

    expect(jiraClient.swapLabel).not.toHaveBeenCalled();
    expect(result.logLine?.outcome).toBe("landed");
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

    const result = await runLoopIteration(makeDeps({ jiraClient, config, runSkill }));

    expect(result.logLine?.outcome).toBe("bounced");
    expect(jiraClient.swapLabel).not.toHaveBeenCalled();
  });

  it("a swapLabel failure (e.g. a malformed Jira request) never throws out of runLoopIteration -- the run still gets logged, and the failure is surfaced via jiraSyncError, not by killing the caller", async () => {
    const jiraClient = makeMockJiraClient({
      // auto-promote label is required to exercise swapLabel at all --
      // a non-auto-promoted landed verdict never calls it (see the
      // "never swaps the label" test above).
      pollOldestMatching: vi.fn(async () =>
        makeTicket({ key: "PROJ-142", labels: ["auto-promote"] }),
      ),
      swapLabel: vi.fn(async () => {
        throw new Error('PUT ... -> 400 Bad Request. {"errors":{"labels":"..."}}');
      }),
    });
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

    let result: LoopIterationResult | undefined;
    await expect(
      (async () => {
        result = await runLoopIteration(makeDeps({ jiraClient, config, runSkill }));
      })(),
    ).resolves.not.toThrow();

    expect(result!.action).toBe("processed");
    expect(result!.jiraSyncError).toMatch(/400 Bad Request/);
    const lines = await readRunLog(runsLogPath);
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("landed");
  });

  it("appends exactly one valid runs.jsonl line for a processed ticket", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () => makeRunSkillResult());

    await runLoopIteration(makeDeps({ jiraClient, runSkill }));

    const lines = await readRunLog(runsLogPath);
    expect(lines).toHaveLength(1);
    expect(lines[0].ticket).toBe("PROJ-142");
    expect(lines[0].outcome).toBe("landed");
    // Regression: tokens must come from the MEASURED usage (main.ts's
    // extractUsage(), threaded through RunSkillResult.tokens), never from
    // verdict.tokens (the skill's own self-report, which is always
    // {in:0,out:0} in practice since neither skill's SKILL.md ever
    // populates it) -- a real bug that silently zeroed every run's logged
    // token count.
    expect(lines[0].tokens).toEqual({ in: 1234, out: 567 });
  });
});
