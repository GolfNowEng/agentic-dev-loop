import { describe, expect, it, vi } from "vitest";
import { runLoopIteration } from "../../../src/roles/dev/phase.ts";
import { buildQaNotesAdf, buildBounceCommentAdf } from "../../../src/roles/dev/code-review.ts";import type { RunSkillFn, LoopIterationDeps, LoopIterationResult } from "../../../src/roles/dev/phase.ts";
import type { JiraClient, JiraTicket } from "../../../src/core/jira-client.ts";
import type { GitHubClient } from "../../../src/core/github-client.ts";
import type { Config, ExecutorVerdict } from "../../../src/core/types.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASSIGNEE_ACCOUNT_ID = "user-123";

function makeConfig(): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "Ready", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" ORDER BY created ASC',
        dev: 'labels = "{label}" AND assignee = "{assignee}" ORDER BY created ASC',
      },
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
    github: { repo: "fandango/webtarsthree" },
  };
}

/** Ticket already assigned to the configured human -- the common case in most tests below. */
function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return {
    key: "PROJ-1",
    status: "In Progress",
    assignee: ASSIGNEE_ACCOUNT_ID,
    labels: [],
    ...overrides,
  };
}

function makeMockJiraClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => null),
    pollAllMatching: vi.fn(async () => []),
    claimTicket: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => {}),
    swapLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    assignTicket: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
    ...overrides,
  };
}

function makeMockGitHubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "https://github.com/org/repo/issues/42" })),
    addComment: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    closePr: vi.fn(async () => "already-closed" as const),
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<ExecutorVerdict> = {}): ExecutorVerdict {
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
    githubClient: makeMockGitHubClient(),
    config: makeConfig(),
    runSkill: vi.fn(),
    loopKind: "dev",
    runsLogPath: "",
    runsToday: 0,
    assigneeAccountId: ASSIGNEE_ACCOUNT_ID,
    execGhPrView: vi.fn(async () => {
      throw new Error("execGhPrView not stubbed for this test");
    }),
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
      expect(jiraClient.swapLabel).not.toHaveBeenCalled();
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
        expect(result.reason).toContain("maxRunsPerDay");
        expect(result.failureCategory).toBe("killed_ceiling");
        // Pre-run pause: no run happened, so nothing to log.
        expect(result.logLine).toBeUndefined();
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
      if (result.kind === "paused") {
        expect(result.reason).toContain("maxCostPerRunUsd");
        expect(result.failureCategory).toBe("killed_ceiling");
      }
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
      if (result.kind === "paused") {
        expect(result.reason).toContain("maxCostPerRunUsd");
        expect(result.failureCategory).toBe("killed_ceiling");
      }
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
      expect(jiraClient.swapLabel).not.toHaveBeenCalled();
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
      if (result.kind === "paused") {
        expect(result.reason).toContain("runTimeoutMin");
        expect(result.failureCategory).toBe("killed_ceiling");
      }
    });
  });

  it("a landed verdict from the dev loop never moves the epic -- only status transitions, to Code Review, with the required PII/QA-notes screen fields populated", async () => {
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
      expect(jiraClient.swapLabel).not.toHaveBeenCalled();
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

  it("a bounced verdict sets outcome bounced and does not move the epic", async () => {
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
      expect(jiraClient.swapLabel).not.toHaveBeenCalled();
      // A real blocker (no PR yet) DOES transition to the configured
      // "bounced" status -- this is the genuine-blocker case Blocked
      // exists for.
      expect(jiraClient.transitionStatus).toHaveBeenCalledWith(
        "PROJ-7",
        config.jira.statusNames.bounced,
      );
    });
  });

  it("a genuine bounce (no PR yet) posts the verdict's evidence as a Jira comment before transitioning to Blocked -- otherwise the ticket goes Blocked with no trace of why, which is the whole reason a human can't tell what happened from Jira alone", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-7b" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "bounced",
          failure_category: "spec_ambiguous",
          detail:
            "AC2 and AC4 pass against unmodified baseline code -- can't confirm RED for the right reason.",
          pr: null,
        }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      await runLoopIteration(deps);

      expect(jiraClient.addComment).toHaveBeenCalledTimes(1);
      const [commentTicket, commentBody] = (jiraClient.addComment as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(commentTicket).toBe("PROJ-7b");
      // Must be an ADF doc (Jira rejects a plain string for comment bodies,
      // same constraint buildQaNotesAdf already documents for QA Notes),
      // and must actually carry the bounce's own evidence -- not a generic
      // "this was bounced" stub that would be just as opaque as no comment.
      expect(commentBody).toMatchObject({ type: "doc" });
      expect(JSON.stringify(commentBody)).toContain("spec_ambiguous");
      expect(JSON.stringify(commentBody)).toContain(
        "AC2 and AC4 pass against unmodified baseline code",
      );

      // The comment must be posted before the status transition happens,
      // so a transient failure after the comment (e.g. a bad Blocked
      // transition) still leaves the evidence on the ticket.
      const addCommentOrder = (jiraClient.addComment as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const transitionOrder = (jiraClient.transitionStatus as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      expect(addCommentOrder).toBeLessThan(transitionOrder);
    });
  });

  it("a genuine bounce also posts the full verdict detail to the mirror GitHub Issue, found by Jira key", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const githubClient = makeMockGitHubClient();
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => makeTicket()),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "bounced",
          pr: null,
          failure_category: "spec_ambiguous",
          detail: "the full bounce detail, longer than Jira's own terser comment",
        }),
        started: "2026-01-01T00:00:00.000Z",
        ended: "2026-01-01T00:01:00.000Z",
        costUsd: 0.5,
        tokens: { in: 100, out: 50 },
      }));

      await runLoopIteration(
        makeDeps({ jiraClient, githubClient, runSkill, runsLogPath }),
      );

      expect(githubClient.findIssueByJiraKey).toHaveBeenCalledWith("PROJ-1");
      expect(githubClient.addComment).toHaveBeenCalledWith(
        42,
        expect.stringContaining("the full bounce detail, longer than Jira's own terser comment"),
      );
    });
  });

  it("a landed verdict also posts PR/verify-loop detail to the mirror GitHub Issue", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const githubClient = makeMockGitHubClient();
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => makeTicket()),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed", pr: "https://github.com/org/repo/pull/9" }),
        started: "2026-01-01T00:00:00.000Z",
        ended: "2026-01-01T00:01:00.000Z",
        costUsd: 0.5,
        tokens: { in: 100, out: 50 },
      }));

      await runLoopIteration(
        makeDeps({ jiraClient, githubClient, runSkill, runsLogPath }),
      );

      expect(githubClient.addComment).toHaveBeenCalledWith(
        42,
        expect.stringContaining("https://github.com/org/repo/pull/9"),
      );
    });
  });

  it("when no mirror Issue is found for this ticket, skips the GitHub write silently -- never an error", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const githubClient = makeMockGitHubClient({
        findIssueByJiraKey: vi.fn(async () => null),
      });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => makeTicket()),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed", pr: "https://github.com/org/repo/pull/9" }),
        started: "2026-01-01T00:00:00.000Z",
        ended: "2026-01-01T00:01:00.000Z",
        costUsd: 0.5,
        tokens: { in: 100, out: 50 },
      }));

      const result = await runLoopIteration(
        makeDeps({ jiraClient, githubClient, runSkill, runsLogPath }),
      );

      expect(githubClient.addComment).not.toHaveBeenCalled();
      expect(result.kind).toBe("ran");
      expect(result.jiraSyncError).toBeUndefined();
    });
  });

  it("a GitHub addComment failure never throws out of runLoopIteration -- surfaced via jiraSyncError, and the Jira-side work still completes", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const githubClient = makeMockGitHubClient({
        addComment: vi.fn(async () => {
          throw new Error("gh: rate limited");
        }),
      });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => makeTicket()),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed", pr: "https://github.com/org/repo/pull/9" }),
        started: "2026-01-01T00:00:00.000Z",
        ended: "2026-01-01T00:01:00.000Z",
        costUsd: 0.5,
        tokens: { in: 100, out: 50 },
      }));

      const result = await runLoopIteration(
        makeDeps({ jiraClient, githubClient, runSkill, runsLogPath }),
      );

      expect(result.kind).toBe("ran");
      expect(result.jiraSyncError).toContain("rate limited");
      expect(jiraClient.transitionStatus).toHaveBeenCalled();
    });
  });

  it("a landed verdict never posts a bounce-evidence comment", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-7c" });
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

      await runLoopIteration(deps);

      expect(jiraClient.addComment).not.toHaveBeenCalled();
    });
  });

  it("a bounce-evidence comment failure never throws out of runLoopIteration -- surfaced via jiraSyncError, and the Blocked transition still happens so the ticket isn't left silently stuck In Progress", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "PROJ-7d" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
        addComment: vi.fn(async () => {
          throw new Error("POST ... -> 400 Bad Request");
        }),
      });
      const config = makeConfig();
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "bounced",
          failure_category: "spec_ambiguous",
          detail: "Acceptance criteria conflict with existing behavior.",
          pr: null,
        }),
        started: "2026-08-16T14:02:11Z",
        ended: "2026-08-16T14:19:40Z",
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
      expect(jiraClient.transitionStatus).toHaveBeenCalledWith(
        "PROJ-7d",
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
      expect(jiraClient.swapLabel).not.toHaveBeenCalled();
      expect(jiraClient.transitionStatus).not.toHaveBeenCalled();
    });
  });

  it("a bounced verdict with an existing PR self-heals the status to Code Review when the ticket is NOT already there -- otherwise the ticket is stuck at whatever status it's really at (e.g. the original Code Review transition silently failed) with no path back, so it keeps re-matching pollJql.dev forever. Confirmed live on TARS-1465: PR #431 landed but the ticket's real status stayed 'In Progress' (the original transition never took), so it re-ran and re-bounced 7+ times over 45 minutes with no self-correction.", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      // Ticket status is "In Progress" (makeTicket's default) while
      // config.jira.statusNames.prOpen is "Code Review" -- the two differ,
      // modeling a ticket whose Code Review transition never actually took.
      const ticket = makeTicket({ key: "TARS-1465" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      config.jira.statusNames.prOpen = "Code Review";
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "bounced",
          failure_category: "blocked",
          detail: "PR #431 already open, mergeable, all CI checks pass. No new work to do.",
          pr: "https://github.com/fandango/webtarsthree/pull/431",
        }),
        started: "2026-09-17T22:22:27Z",
        ended: "2026-09-17T22:24:55Z",
        costUsd: MEASURED_COST_USD,
        tokens: MEASURED_TOKENS,
      }));

      const deps = makeDeps({ jiraClient, config, runSkill, runsLogPath });

      const result = await runLoopIteration(deps);

      expect(result.kind).toBe("ran");
      expect(jiraClient.swapLabel).not.toHaveBeenCalled();
      expect(jiraClient.transitionStatus).toHaveBeenCalledTimes(1);
      expect(jiraClient.transitionStatus).toHaveBeenCalledWith(
        "TARS-1465",
        "Code Review",
        expect.objectContaining({ customfield_13504: expect.anything() }),
      );
    });
  });

  it("a bounced verdict with an existing PR does NOT re-transition when the ticket is already at Code Review -- the self-heal is idempotent, it only fires when the ticket's real status disagrees with prOpen", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const ticket = makeTicket({ key: "TARS-1389", status: "Code Review" });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => ticket),
      });
      const config = makeConfig();
      config.jira.statusNames.prOpen = "Code Review";
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "bounced",
          failure_category: "blocked",
          detail: "PR #400 already open; ticket already at Code Review.",
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
      expect(jiraClient.swapLabel).not.toHaveBeenCalled();
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
      const pollAllMatching = vi.fn(async () => []);
      const claimTicket = vi.fn(async () => true);
      const transitionStatus = vi.fn(async () => {});
      const swapLabel = vi.fn(async () => {});
      const assignTicket = vi.fn(async () => {});
      const addComment = vi.fn(async () => {});
      const closeTicket = vi.fn(async () => ({ result: "already-done" as const }));
      const jiraClient: JiraClient = {
        pollOldestMatching,
        pollAllMatching,
        claimTicket,
        transitionStatus,
        swapLabel,
        assignTicket,
        addComment,
        closeTicket,
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

describe("buildBounceCommentAdf", () => {
  it("opens with the '{icon} dev-loop - <short context>' convention as its bold first line, not the old 'Bounced (<category>):' prefix", () => {
    const adf = buildBounceCommentAdf(
      makeVerdict({
        outcome: "bounced",
        failure_category: "spec_ambiguous",
        detail: "AC 3's assertion strategy is unspecified.",
      }),
    );

    const firstParagraph = (adf.content as Array<Record<string, unknown>>)[0];
    const firstTextNode = (firstParagraph.content as Array<Record<string, unknown>>)[0];
    expect(firstTextNode.text).toBe("❌ dev-loop - spec_ambiguous: ");
    expect((firstTextNode.marks as Array<{ type: string }>)[0].type).toBe("strong");
  });

  it("still includes the verdict's own detail text as the comment body, unchanged", () => {
    const adf = buildBounceCommentAdf(
      makeVerdict({ outcome: "bounced", failure_category: "blocked", detail: "Needs a human call." }),
    );
    const firstParagraph = (adf.content as Array<Record<string, unknown>>)[0];
    const detailTextNode = (firstParagraph.content as Array<Record<string, unknown>>)[1];
    expect(detailTextNode.text).toBe("Needs a human call.");
  });
});

describe("buildQaNotesAdf", () => {
  it("with qa_notes set: builds a bold 'Manual testing steps:' header followed by an ordered list, one listItem per entry, with Expected: entries bold-marked -- matching the retired interactive qa-notes/push-branch skills' ADF shape, not the PR-link stub", () => {
    const verdict = makeVerdict({
      qa_notes: [
        "Navigate to `/rotten-tomatoes/critics?query=tina+kakad`",
        "Expected: the Self-Service badge appears next to the critic's name",
      ],
    });

    const adf = buildQaNotesAdf(verdict) as {
      type: string;
      content: Array<Record<string, unknown>>;
    };

    expect(adf.type).toBe("doc");
    expect(adf.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Manual testing steps:", marks: [{ type: "strong" }] }],
    });

    const orderedList = adf.content[1] as {
      type: string;
      attrs: { order: number };
      content: Array<Record<string, unknown>>;
    };
    expect(orderedList.type).toBe("orderedList");
    expect(orderedList.content).toHaveLength(2);

    // Plain step: no bold mark.
    expect(orderedList.content[0]).toEqual({
      type: "listItem",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Navigate to `/rotten-tomatoes/critics?query=tina+kakad`" },
          ],
        },
      ],
    });

    // "Expected:" step: that prefix is bold-marked, rest is plain.
    expect(orderedList.content[1]).toEqual({
      type: "listItem",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Expected:", marks: [{ type: "strong" }] },
            {
              type: "text",
              text: " the Self-Service badge appears next to the critic's name",
            },
          ],
        },
      ],
    });
  });

  it("with qa_notes absent: falls back to the existing PR-link stub, unchanged -- regression guard for verdicts that predate this field or a bounce with no notes to give", () => {
    const verdict = makeVerdict({ pr: "https://github.com/org/repo/pull/42", verify_loops: 2 });
    delete (verdict as Partial<ExecutorVerdict>).qa_notes;

    const adf = buildQaNotesAdf(verdict) as {
      type: string;
      content: Array<Record<string, unknown>>;
    };

    expect(adf).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "PR: https://github.com/org/repo/pull/42" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Verify loops: 2" }],
        },
      ],
    });
  });

  it("with qa_notes an empty array: falls back to the PR-link stub, same as absent", () => {
    const verdict = makeVerdict({ qa_notes: [] });

    const adf = buildQaNotesAdf(verdict) as { content: Array<Record<string, unknown>> };

    expect(adf.content).toHaveLength(2);
    expect(adf.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: expect.stringContaining("PR:") }],
    });
  });
});

describe("runLoopIteration -- landed-ticket guard", () => {
  const landedLine = {
    ticket: "PROJ-1", skill: "ticket-to-pr", skill_version: "x", model: "sonnet",
    started: "2026-01-01T00:00:00.000Z", ended: "2026-01-01T00:10:00.000Z",
    outcome: "landed", phase_reached: "pr", red_confirmed: true, verify_loops: 1, retries: 0,
    failure_category: null, detail: "landed", pr: "https://github.com/org/repo/pull/9",
    cost_usd: 1, tokens: { in: 1, out: 1 },
  };

  /** pollOldestMatching stand-in: returns the first queued ticket whose key the JQL hasn't excluded. */
  function queuePoll(tickets: JiraTicket[]) {
    return vi.fn(
      async (jql: string) =>
        tickets.find((t) => !new RegExp(`key not in \\([^)]*"${t.key}"`).test(jql)) ?? null,
    );
  }

  async function withLanded<T>(fn: (path: string) => Promise<T>): Promise<T> {
    return withTempRunsLog(async (path) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, JSON.stringify(landedLine) + "\n", "utf8");
      return fn(path);
    });
  }

  it("does not run the skill for a polled ticket whose landed PR merged (post-merge Jira status, label still present)", async () => {
    await withLanded(async (runsLogPath) => {
      const runSkill: RunSkillFn = vi.fn();
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: queuePoll([makeTicket({ status: "Development Complete" })]),
      });
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" }));

      const result = await runLoopIteration(makeDeps({ jiraClient, runSkill, runsLogPath, execGhPrView }));

      expect(runSkill).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: "idle", skipped: [{ ticket: "PROJ-1", reason: expect.stringContaining("merged") }] });
    });
  });

  it("does not run the skill for a ticket whose landed PR is still open", async () => {
    await withLanded(async (runsLogPath) => {
      const runSkill: RunSkillFn = vi.fn();
      const jiraClient = makeMockJiraClient({ pollOldestMatching: queuePoll([makeTicket()]) });
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "OPEN", mergedAt: null }));

      const result = await runLoopIteration(makeDeps({ jiraClient, runSkill, runsLogPath, execGhPrView }));

      expect(runSkill).not.toHaveBeenCalled();
      expect(result.kind).toBe("idle");
    });
  });

  it("skips past a landed ticket and runs the next eligible one (a stuck landed ticket never blocks the queue)", async () => {
    await withLanded(async (runsLogPath) => {
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "bounced", pr: null, failure_category: "spec_ambiguous" }),
        started: "2026-01-03T00:00:00.000Z", ended: "2026-01-03T00:01:00.000Z", costUsd: 1, tokens: MEASURED_TOKENS,
      }));
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: queuePoll([makeTicket({ key: "PROJ-1" }), makeTicket({ key: "PROJ-2" })]),
      });
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" }));

      const result = await runLoopIteration(makeDeps({ jiraClient, runSkill, runsLogPath, execGhPrView }));

      expect(runSkill).toHaveBeenCalledWith("PROJ-2");
      expect(result.kind).toBe("ran");
    });
  });

  it("still runs a ticket whose previous landed PR was closed without merging", async () => {
    await withLanded(async (runsLogPath) => {
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "bounced", pr: null, failure_category: "spec_ambiguous" }),
        started: "2026-01-03T00:00:00.000Z", ended: "2026-01-03T00:01:00.000Z", costUsd: 1, tokens: MEASURED_TOKENS,
      }));
      const jiraClient = makeMockJiraClient({ pollOldestMatching: queuePoll([makeTicket()]) });
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "CLOSED", mergedAt: null }));

      await runLoopIteration(makeDeps({ jiraClient, runSkill, runsLogPath, execGhPrView }));

      expect(runSkill).toHaveBeenCalledWith("PROJ-1");
    });
  });

  it("fails closed: if the PR state cannot be read, the ticket is skipped, not run", async () => {
    await withLanded(async (runsLogPath) => {
      const runSkill: RunSkillFn = vi.fn();
      const jiraClient = makeMockJiraClient({ pollOldestMatching: queuePoll([makeTicket()]) });
      const execGhPrView = vi.fn(async () => { throw new Error("gh: network"); });

      const result = await runLoopIteration(makeDeps({ jiraClient, runSkill, runsLogPath, execGhPrView }));

      expect(runSkill).not.toHaveBeenCalled();
      expect(result.kind).toBe("idle");
    });
  });
});
