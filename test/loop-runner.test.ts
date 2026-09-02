import { describe, expect, it, vi } from "vitest";
import { runLoopIteration } from "../src/loop-runner.ts";
import type { RunSkillFn, LoopIterationDeps, LoopIterationResult } from "../src/loop-runner.ts";
import type { JiraClient, JiraTicket } from "../src/jira-client.ts";
import type { Config, Verdict } from "../src/types.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASSIGNEE_ACCOUNT_ID = "user-123";

function makeConfig(): Config {
  return {
    jira: {
      intakeEpics: ["EPIC-1"],
      readyEpic: "EPIC-READY",
      claimStatus: { from: "Ready", to: "In Progress" },
      pollJql: {
        refine: 'epic in ({epics}) ORDER BY created ASC',
        dev: 'epic = {readyEpic} AND assignee = "{assignee}" ORDER BY created ASC',
      },
      epicLinkField: "customfield_10014",
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
      codeReviewFields: {
        piiField: "customfield_13504",
        piiNoImpactOptionId: "14310",
        qaNotesField: "customfield_14226",
      },
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}

/** Ticket already assigned to the configured human -- the common case in most tests below. */
function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return {
    key: "PROJ-1",
    status: "In Progress",
    epic: "EPIC-READY",
    assignee: ASSIGNEE_ACCOUNT_ID,
    ...overrides,
  };
}

function makeMockJiraClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => null),
    claimTicket: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => {}),
    moveToEpic: vi.fn(async () => {}),
    assignTicket: vi.fn(async () => {}),
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

/** Default measured cost for a mocked runSkill, matching makeVerdict's cost_usd. */
const MEASURED_COST_USD = 1.0;
/** Default measured tokens for a mocked runSkill -- deliberately different from any verdict.tokens value, so a test asserting on this exposes a bug that reads verdict.tokens instead. */
const MEASURED_TOKENS = { in: 1234, out: 567 };

function makeDeps(overrides: Partial<LoopIterationDeps> = {}): LoopIterationDeps {
  return {
    jiraClient: makeMockJiraClient(),
    config: makeConfig(),
    runSkill: vi.fn(),
    loopKind: "dev",
    runsLogPath: "",
    runsToday: 0,
    assigneeAccountId: ASSIGNEE_ACCOUNT_ID,
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
  it("returns idle when polling finds no matching ticket, without running the skill", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => null),
      });
      const runSkill: RunSkillFn = vi.fn();

      const deps = makeDeps({ jiraClient, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("idle");
      expect(runSkill).not.toHaveBeenCalled();
      expect(jiraClient.assignTicket).not.toHaveBeenCalled();
    });
  });

  it("never calls claimTicket -- this MVP has no atomic claim step for dev-loop (single-instance assumption; see docs/config.md's multi-instance note)", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-1" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("ran");
      expect(jiraClient.claimTicket).not.toHaveBeenCalled();
      expect(runSkill).toHaveBeenCalledWith("PROJ-1");
    });
  });

  it("assigns the ticket to the configured human when it's currently unassigned", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-10", assignee: null });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, runSkill, runsLogPath });

      await runLoopIteration(deps);

      expect(jiraClient.assignTicket).toHaveBeenCalledWith(
        "PROJ-10",
        ASSIGNEE_ACCOUNT_ID,
      );
    });
  });

  it("does not call assignTicket when the ticket already has an assignee", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-11", assignee: "someone-else" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, runSkill, runsLogPath });

      await runLoopIteration(deps);

      expect(jiraClient.assignTicket).not.toHaveBeenCalled();
    });
  });

  it("an assignTicket failure never throws out of runLoopIteration -- the run still proceeds and completes, surfaced via jiraSyncError", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-12", assignee: null });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        assignTicket: vi.fn(async () => {
          throw new Error("PUT ... -> 400 Bad Request");
        }),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, runSkill, runsLogPath });

      let result: LoopIterationResult | undefined;
      await expect(
        (async () => {
          result = await runLoopIteration(deps);
        })(),
      ).resolves.not.toThrow();

      expect(runSkill).toHaveBeenCalled();
      expect(result!.kind).toBe("ran");
      if (result!.kind === "ran") {
        expect(result!.jiraSyncError).toMatch(/400 Bad Request/);
      }
    });
  });

  it("malformed/missing verdict.json is treated as outcome error / failure_category agent_error and still logged", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-2" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "error",
          failure_category: "agent_error",
          detail: "verdict.json was missing or malformed",
        }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:05:00Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, runSkill, runsLogPath });

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
      const ticket = makeTicket({ key: "PROJ-3" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:05:00Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const config = makeConfig();
      const deps = makeDeps({
        jiraClient,
        config,
        runSkill,
        runsLogPath,
        // Already at the ceiling before this run even started.
        runsToday: config.ceilings.maxRunsPerDay,
      });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("paused");
      if (result.kind === "paused") {
        expect(result.reason).toBeTruthy();
      }
    });
  });

  it("ceiling breach (cost/run) pauses the loop rather than silently continuing", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-4" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ cost_usd: config.ceilings.maxCostPerRunUsd + 1 }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:05:00Z",
        costUsd: config.ceilings.maxCostPerRunUsd + 1,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("paused");
    });
  });

  it("ceiling breach (cost/run): pauses using the MEASURED cost, even when the verdict under-reports its own cost_usd", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-4b" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      // The skill under-reports its own cost (e.g. a bug, or a misbehaving
      // agent) but the measured cost from the claude -p spawn is what
      // actually breaches the ceiling -- checkCeilings must trust the
      // measured value, never the skill's self-report.
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ cost_usd: 0.01 }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:05:00Z",
        costUsd: config.ceilings.maxCostPerRunUsd + 1,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("paused");
    });
  });

  it("a post-run ceiling breach still records the run's real consequences (Code Review transition, runs.jsonl) before pausing -- a completed, valid verdict must never be silently discarded", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-4c" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed" }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:05:00Z",
        // Breaches maxCostPerRunUsd, but only known AFTER the run completed.
        costUsd: config.ceilings.maxCostPerRunUsd + 1,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("paused");
      // The verdict was real and passing -- its consequences must still
      // happen, not be thrown away just because the ceiling was breached
      // after the fact. A landed dev-loop verdict never moves the epic --
      // only its status transitions, to Code Review.
      expect(jiraClient.moveToEpic).not.toHaveBeenCalled();
      expect(jiraClient.transitionStatus).toHaveBeenCalledWith(
        "PROJ-4c",
        config.jira.statusNames.prOpen,
        expect.anything(),
      );
      const raw = await readFile(runsLogPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]).outcome).toBe("landed");
    });
  });

  it("a Code Review transition failure (e.g. a malformed Jira request) never throws out of runLoopIteration -- the run still gets logged, and the failure is surfaced via jiraSyncError, not by killing the caller", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-4d" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        transitionStatus: vi.fn(async () => {
          throw new Error('PUT ... -> 400 Bad Request. {"errors":{"customfield_13504":"..."}}');
        }),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed" }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:05:00Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      let result: LoopIterationResult | undefined;
      await expect(
        (async () => {
          result = await runLoopIteration(deps);
        })(),
      ).resolves.not.toThrow();

      expect(result!.kind).toBe("ran");
      if (result!.kind === "ran") {
        expect(result!.jiraSyncError).toMatch(/400 Bad Request/);
      }
      const raw = await readFile(runsLogPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]).outcome).toBe("landed");
    });
  });

  it("ceiling breach (run timeout) pauses the loop rather than silently continuing", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-5" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        // Timeout is 30 min; make this run take much longer.
        started: "2026-08-16T14:00:00Z",
        ended: "2026-08-16T15:30:00Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("paused");
    });
  });

  it("epic-move-on-verdict: a landed verdict from the dev loop never moves the epic -- only status transitions, to Code Review, with the required PII/QA-notes screen fields populated", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-6" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed" }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("ran");
      // A landed dev-loop verdict never moves the epic -- the ticket
      // stays in Pipeline: dev-loop. Moving it to research-loop's epic
      // would overload one epic to mean two different things depending
      // on which ticket you're looking at.
      expect(jiraClient.moveToEpic).not.toHaveBeenCalled();
      expect(jiraClient.transitionStatus).toHaveBeenCalledWith(
        "PROJ-6",
        config.jira.statusNames.prOpen,
        expect.anything(),
      );
    });
  });

  it("a landed dev-loop verdict also transitions the ticket to Code Review, with the required PII/QA-notes screen fields populated", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-6b" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "landed",
          pr: "https://github.com/org/repo/pull/42",
          verify_loops: 2,
        }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      await runLoopIteration(deps);

      expect(jiraClient.transitionStatus).toHaveBeenCalledWith(
        "PROJ-6b",
        config.jira.statusNames.prOpen,
        {
          [config.jira.codeReviewFields.piiField]: [
            { id: config.jira.codeReviewFields.piiNoImpactOptionId },
          ],
          [config.jira.codeReviewFields.qaNotesField]: expect.objectContaining({
            type: "doc",
            content: expect.arrayContaining([
              expect.objectContaining({
                content: expect.arrayContaining([
                  expect.objectContaining({
                    text: expect.stringContaining("https://github.com/org/repo/pull/42"),
                  }),
                ]),
              }),
            ]),
          }),
        },
      );
    });
  });

  it("a refine-loop landed verdict does NOT transition to Code Review -- that's dev-loop-only behavior", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-6c" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed" }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath, loopKind: "refine" });

      await runLoopIteration(deps);

      expect(jiraClient.transitionStatus).not.toHaveBeenCalled();
    });
  });

  it("epic-move-on-verdict: a bounced verdict sets outcome bounced and does not move the epic", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-7" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "bounced",
          failure_category: "spec_ambiguous",
          detail: "Acceptance criteria conflict with existing behavior.",
          // A genuine blocker never reaches Phase 5 (PR) -- pr is null.
          pr: null,
        }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("ran");
      if (result.kind === "ran") {
        expect(result.logLine.outcome).toBe("bounced");
      }
      expect(jiraClient.moveToEpic).not.toHaveBeenCalled();
      // A real blocker (no PR yet) DOES transition to the configured
      // "bounced" status -- this is the genuine-blocker case Blocked
      // exists for.
      expect(jiraClient.transitionStatus).toHaveBeenCalledWith(
        "PROJ-7",
        config.jira.statusNames.bounced,
      );
    });
  });

  it("a bounced verdict that already has a PR (e.g. intake found this ticket's work already landed, nothing to do) does NOT transition to Blocked -- that would stomp a status the ticket may have already correctly moved past. Confirmed live on TARS-1389: a race produced a second run that bounced cleanly with an existing PR, and the unconditional transition clobbered the ticket's just-set Code Review status back to Blocked.", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "TARS-1389" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "bounced",
          failure_category: "blocked",
          detail:
            "PR #400 already open for TARS-1389; ticket status is already Code Review. No new worktree created, no duplicate work performed.",
          pr: "https://github.com/fandango/webtarsthree/pull/400",
        }),
        started: "2026-09-02T02:49:16Z",
        ended: "2026-09-02T02:50:42Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("ran");
      expect(jiraClient.moveToEpic).not.toHaveBeenCalled();
      expect(jiraClient.transitionStatus).not.toHaveBeenCalled();
    });
  });

  it("appends exactly one valid runs.jsonl line per run, matching the schema", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-8" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, runSkill, runsLogPath });

      await runLoopIteration(deps);

      const raw = await readFile(runsLogPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.ticket).toBe("PROJ-8");
      expect(typeof parsed.started).toBe("string");
      // Regression: tokens must come from the MEASURED usage (main.ts's
      // extractUsage() via runSkill), never from verdict.tokens (the
      // skill's own self-report, which is always {in:0,out:0} in practice
      // since neither skill's SKILL.md ever populates it) -- a real bug
      // that silently zeroed every run's logged token count.
      expect(parsed.tokens).toEqual(MEASURED_TOKENS);
      expect(typeof parsed.ended).toBe("string");
      expect(["landed", "bounced", "error", "killed"]).toContain(
        parsed.outcome,
      );
    });
  });

  it("never touches a real JiraClient implementation or a real process - only the injected mocks are called", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-9" });
      const pollOldestMatching = vi.fn(async () => ticket);
      const claimTicket = vi.fn(async () => true);
      const transitionStatus = vi.fn(async () => {});
      const moveToEpic = vi.fn(async () => {});
      const assignTicket = vi.fn(async () => {});
      const jiraClient: JiraClient = {
        pollOldestMatching,
        claimTicket,
        transitionStatus,
        moveToEpic,
        assignTicket,
      };
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict(),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, runSkill, runsLogPath });

      await runLoopIteration(deps);

      expect(pollOldestMatching).toHaveBeenCalled();
      expect(runSkill).toHaveBeenCalledWith("PROJ-9");
    });
  });
});
