import { describe, it, expect, vi } from "vitest";
import { reconcileMergedTickets } from "../../../src/roles/dev/reconcile.ts";
import type { IterationRecord } from "../../../src/core/iteration-log.ts";
import type { JiraClient, JiraTicket } from "../../../src/core/jira-client.ts";
import type { GitHubClient } from "../../../src/core/github-client.ts";
import type { Config, RunLogLine } from "../../../src/core/types.ts";
import { makeV2Config } from "../../fixtures/config.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** research trigger "pipeline:v2.0.0", handoff = dev trigger "pipeline:dev". */
function makeConfig(): Config {
  return makeV2Config((c) => {
    c.roles.research.handoffLabel = "pipeline:dev";
    c.roles.dev.triggerLabel = "pipeline:dev";
  });
}

function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return { key: "PROJ-1", status: "Development Complete", assignee: "user-123", labels: [], ...overrides };
}

function makeRunLogLine(overrides: Partial<RunLogLine> = {}): RunLogLine {
  return {
    ticket: "PROJ-1",
    skill: "ticket-to-pr",
    skill_version: "abc1234",
    model: "sonnet",
    started: "2026-01-01T00:00:00.000Z",
    ended: "2026-01-01T00:10:00.000Z",
    outcome: "landed",
    phase_reached: "pr",
    red_confirmed: true,
    verify_loops: 1,
    retries: 0,
    failure_category: null,
    detail: "landed",
    pr: "https://github.com/org/repo/pull/9",
    cost_usd: 1.0,
    tokens: { in: 100, out: 50 },
    ...overrides,
  };
}

/** A temp repo root with the given lines as the post-cutover v1 dev log (runs/v1/dev/proj.jsonl). */
async function withRunsLog(lines: RunLogLine[], fn: (root: string) => Promise<void>, v2?: IterationRecord[]): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "reconcile-test-"));
  if (lines.length > 0) {
    await mkdir(join(root, "runs/v1/dev"), { recursive: true });
    await writeFile(join(root, "runs/v1/dev/proj.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }
  if (v2) {
    await mkdir(join(root, "runs/v2"), { recursive: true });
    await writeFile(join(root, "runs/v2/proj.jsonl"), v2.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function v2Landed(ticket: string, pr: string, ended = "2026-01-03T00:00:00.000Z"): IterationRecord {
  return {
    ticket, session: "dev-1", loop_version: "2.0.0", started: ended, ended, outcome: "landed",
    phases: [{
      role: "dev", skill: "ticket-to-pr", skill_version: "s", model: "sonnet", started: ended, ended,
      outcome: "landed", phase_reached: "pr", cost_usd: 1, tokens: { in: 1, out: 1 }, failure_category: null,
      detail: "ok", pr, run_dir: "d",
    }],
  };
}

/** The common deps every case passes: slug "proj" under the fixture root, session "dev-1". */
const at = (root: string) => ({ slug: "proj", root, session: "dev-1" });

const NOW = new Date("2026-01-05T00:00:00Z");

function makeJira(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(),
    pollAllMatching: vi.fn(async () => []),
    claimTicket: vi.fn(),
    transitionStatus: vi.fn(),
    swapLabel: vi.fn(),
    removeLabel: vi.fn(async () => {}),
    assignTicket: vi.fn(),
    addComment: vi.fn(),
    closeTicket: vi.fn(async () => ({ result: "already-done" as const })),
    ...overrides,
  };
}

function makeGh(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "https://github.com/org/repo/issues/42", state: "OPEN" as const })),
    addComment: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    closePr: vi.fn(async () => "already-closed" as const),
    ...overrides,
  };
}

const merged = () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T03:04:05Z" });
const open = () => JSON.stringify({ state: "OPEN", mergedAt: null });

describe("reconcileMergedTickets", () => {
  it("closes the mirror Issue and removes pipeline:dev for a landed ticket whose PR merged while the loop was off (Jira status is irrelevant, no JQL used)", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const jiraClient = makeJira();
      const githubClient = makeGh();
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), ...at(root), execGhPrView: vi.fn(async () => merged()), now: NOW,
      });

      expect(result).toEqual({ checked: 1, closed: ["PROJ-1"], errors: [] });
      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
      expect(jiraClient.removeLabel).toHaveBeenCalledWith("PROJ-1", "pipeline:dev");
      expect(jiraClient.pollAllMatching).not.toHaveBeenCalled();
    });
  });

  it("leaves a landed ticket whose PR is still open completely alone", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const jiraClient = makeJira();
      const githubClient = makeGh();
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), ...at(root), execGhPrView: vi.fn(async () => open()), now: NOW,
      });

      expect(result).toEqual({ checked: 1, closed: [], errors: [] });
      expect(githubClient.closeIssue).not.toHaveBeenCalled();
      expect(jiraClient.removeLabel).not.toHaveBeenCalled();
    });
  });

  it("when the recorded PR was closed unmerged but another PR for the ticket merged (TARS-1487: #470 closed, #476 merged), closes the Issue and removes pipeline:dev", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const jiraClient = makeJira();
      const githubClient = makeGh();
      const execGhFindMergedPr = vi.fn(async () => ({ url: "https://github.com/org/repo/pull/12", mergedAt: "2026-01-03T04:05:06Z" }));
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), ...at(root), now: NOW,
        execGhPrView: vi.fn(async () => JSON.stringify({ state: "CLOSED", mergedAt: null })),
        execGhFindMergedPr,
      });

      expect(execGhFindMergedPr).toHaveBeenCalledWith("PROJ-1");
      expect(result).toEqual({ checked: 1, closed: ["PROJ-1"], errors: [] });
      expect(githubClient.addComment).toHaveBeenCalledWith(42, expect.stringContaining("https://github.com/org/repo/pull/12"));
      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
      expect(jiraClient.removeLabel).toHaveBeenCalledWith("PROJ-1", "pipeline:dev");
    });
  });

  it("closed-unmerged PR with no other merged PR for the ticket is left alone", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const jiraClient = makeJira();
      const githubClient = makeGh();
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), ...at(root), now: NOW,
        execGhPrView: vi.fn(async () => JSON.stringify({ state: "CLOSED", mergedAt: null })),
        execGhFindMergedPr: vi.fn(async () => null),
      });

      expect(result).toEqual({ checked: 1, closed: [], errors: [] });
      expect(githubClient.closeIssue).not.toHaveBeenCalled();
      expect(jiraClient.removeLabel).not.toHaveBeenCalled();
    });
  });

  it("does not search for another PR while the recorded PR is still open", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const execGhFindMergedPr = vi.fn(async () => null);
      await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), now: NOW,
        execGhPrView: vi.fn(async () => open()),
        execGhFindMergedPr,
      });
      expect(execGhFindMergedPr).not.toHaveBeenCalled();
    });
  });

  it("is a safe no-op when runs.jsonl has no landed tickets", async () => {
    await withRunsLog([makeRunLogLine({ outcome: "bounced", pr: null, failure_category: "spec_ambiguous" })], async (root) => {
      const execGhPrView = vi.fn();
      const result = await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView, now: NOW,
      });
      expect(result).toEqual({ checked: 0, closed: [], errors: [] });
      expect(execGhPrView).not.toHaveBeenCalled();
    });
  });

  it("ignores landed lines older than the 30-day window", async () => {
    await withRunsLog([makeRunLogLine({ started: "2025-11-01T00:00:00.000Z", ended: "2025-11-01T00:10:00.000Z" })], async (root) => {
      const execGhPrView = vi.fn();
      const result = await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView, now: NOW,
      });
      expect(result.checked).toBe(0);
      expect(execGhPrView).not.toHaveBeenCalled();
    });
  });

  it("checks each ticket once, using its latest landed PR", async () => {
    await withRunsLog(
      [
        makeRunLogLine({ pr: "https://github.com/org/repo/pull/1", ended: "2026-01-01T00:00:00.000Z" }),
        makeRunLogLine({ pr: "https://github.com/org/repo/pull/2", ended: "2026-01-02T00:00:00.000Z" }),
      ],
      async (root) => {
        const execGhPrView = vi.fn(async () => open());
        const result = await reconcileMergedTickets({
          jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView, now: NOW,
        });
        expect(result.checked).toBe(1);
        expect(execGhPrView).toHaveBeenCalledTimes(1);
        expect(execGhPrView).toHaveBeenCalledWith("https://github.com/org/repo/pull/2");
      },
    );
  });

  it("an already-closed mirror Issue gets no second comment or close, but the label is still removed", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const jiraClient = makeJira();
      const githubClient = makeGh({
        findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "x", state: "CLOSED" as const })),
      });
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), ...at(root), execGhPrView: vi.fn(async () => merged()), now: NOW,
      });

      expect(result.closed).toEqual(["PROJ-1"]);
      expect(githubClient.addComment).not.toHaveBeenCalled();
      expect(githubClient.closeIssue).not.toHaveBeenCalled();
      expect(jiraClient.removeLabel).toHaveBeenCalledWith("PROJ-1", "pipeline:dev");
    });
  });

  it("does not re-check a ticket already reconciled earlier in this process (shared `reconciled` set)", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const execGhPrView = vi.fn(async () => merged());
      const reconciled = new Set<string>();
      const deps = { jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView, now: NOW, reconciled };

      await reconcileMergedTickets(deps);
      const second = await reconcileMergedTickets(deps);

      expect(execGhPrView).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ checked: 0, closed: [], errors: [] });
    });
  });

  it("a failed label removal does not block the Issue close and is not reported as an error", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const jiraClient = makeJira({ removeLabel: vi.fn(async () => { throw new Error("jira 500"); }) });
      const githubClient = makeGh();
      const result = await reconcileMergedTickets({
        jiraClient, githubClient, config: makeConfig(), ...at(root), execGhPrView: vi.fn(async () => merged()), now: NOW,
      });

      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
      expect(result).toEqual({ checked: 1, closed: ["PROJ-1"], errors: [] });
    });
  });

  it("a gh pr view failure for one ticket is recorded and does not stop the rest", async () => {
    await withRunsLog(
      [
        makeRunLogLine({ ticket: "PROJ-1", pr: "https://github.com/org/repo/pull/9" }),
        makeRunLogLine({ ticket: "PROJ-2", pr: "https://github.com/org/repo/pull/10" }),
      ],
      async (root) => {
        const execGhPrView = vi.fn(async (url: string) => {
          if (url.endsWith("/9")) throw new Error("gh: network error");
          return merged();
        });
        const result = await reconcileMergedTickets({
          jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView, now: NOW,
        });

        expect(result.checked).toBe(2);
        expect(result.closed).toEqual(["PROJ-2"]);
        expect(result.errors).toEqual([{ ticket: "PROJ-1", message: expect.stringContaining("network error") }]);
      },
    );
  });
});

describe("reconcileMergedTickets -- v1/v2 logs and labels", () => {
  it("finds a v1-only landed ticket (runs/v1/dev/<slug>.jsonl)", async () => {
    await withRunsLog([makeRunLogLine({ ticket: "PROJ-1" })], async (root) => {
      const execGhPrView = vi.fn(async () => open());
      const result = await reconcileMergedTickets({ jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView, now: NOW });
      expect(result.checked).toBe(1);
      expect(execGhPrView).toHaveBeenCalledWith("https://github.com/org/repo/pull/9");
    });
  });

  it("finds a v1-only landed ticket in the pre-cutover dev log (runs/<slug>.jsonl) when runs/v1/ is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "reconcile-test-"));
    try {
      await mkdir(join(root, "runs"), { recursive: true });
      await writeFile(join(root, "runs/proj.jsonl"), JSON.stringify(makeRunLogLine({ pr: "https://github.com/org/repo/pull/3" })) + "\n");
      const execGhPrView = vi.fn(async () => open());
      const result = await reconcileMergedTickets({ jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView, now: NOW });
      expect(result.checked).toBe(1);
      expect(execGhPrView).toHaveBeenCalledWith("https://github.com/org/repo/pull/3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds a v2-only landed ticket (runs/v2/<slug>.jsonl dev phase)", async () => {
    await withRunsLog([], async (root) => {
      const execGhPrView = vi.fn(async () => merged());
      const result = await reconcileMergedTickets({ jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView, now: NOW });
      expect(result).toEqual({ checked: 1, closed: ["PROJ-7"], errors: [] });
      expect(execGhPrView).toHaveBeenCalledWith("https://github.com/org/repo/pull/70");
    }, [v2Landed("PROJ-7", "https://github.com/org/repo/pull/70")]);
  });

  it("v2 wins when both logs record the ticket", async () => {
    await withRunsLog([makeRunLogLine({ ticket: "PROJ-1", pr: "https://github.com/org/repo/pull/9" })], async (root) => {
      const execGhPrView = vi.fn(async () => open());
      const result = await reconcileMergedTickets({ jiraClient: makeJira(), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView, now: NOW });
      expect(result.checked).toBe(1);
      expect(execGhPrView).toHaveBeenCalledTimes(1);
      expect(execGhPrView).toHaveBeenCalledWith("https://github.com/org/repo/pull/99");
    }, [v2Landed("PROJ-1", "https://github.com/org/repo/pull/99")]);
  });

  it("removes every pipeline label: research trigger, handoff, dev trigger, pipeline:research, pipeline:dev (each once)", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const jiraClient = makeJira();
      await reconcileMergedTickets({ jiraClient, githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView: vi.fn(async () => merged()), now: NOW });
      const labels = (jiraClient.removeLabel as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]).sort();
      expect(labels).toEqual(["pipeline:dev", "pipeline:research", "pipeline:v2.0.0"]);
      for (const c of (jiraClient.removeLabel as ReturnType<typeof vi.fn>).mock.calls) expect(c[0]).toBe("PROJ-1");
    });
  });

  it("one failing label removal does not stop the others", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const removeLabel = vi.fn(async (_k: string, l: string) => {
        if (l === "pipeline:v2.0.0") throw new Error("jira 500");
      });
      const result = await reconcileMergedTickets({ jiraClient: makeJira({ removeLabel }), githubClient: makeGh(), config: makeConfig(), ...at(root), execGhPrView: vi.fn(async () => merged()), now: NOW });
      expect(removeLabel).toHaveBeenCalledTimes(3);
      expect(result.closed).toEqual(["PROJ-1"]);
    });
  });
});

describe("reconcileMergedTickets -- close comment", () => {
  it("posts the templated comment on the mirror Issue before closing it", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const githubClient = makeGh();
      await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient, config: makeConfig(), ...at(root), execGhPrView: vi.fn(async () => merged()), now: NOW,
      });

      const [issueNumber, body] = (githubClient.addComment as ReturnType<typeof vi.fn>).mock.calls[0] as [number, string];
      expect(issueNumber).toBe(42);
      expect(body).toBe(
        [
          "**Closed automatically by dev-loop**",
          "",
          "PR: https://github.com/org/repo/pull/9",
          "Merged: 2026-01-02 03:04 UTC",
          "Ticket: PROJ-1",
          "Reason: PR merged, closed as completed",
          "",
          "— dev-1",
        ].join("\n"),
      );
      const c = (githubClient.addComment as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const x = (githubClient.closeIssue as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(c).toBeLessThan(x);
    });
  });

  it("still closes the Issue, with no error, when posting the comment fails", async () => {
    await withRunsLog([makeRunLogLine()], async (root) => {
      const githubClient = makeGh({ addComment: vi.fn(async () => { throw new Error("rate limited"); }) });
      const result = await reconcileMergedTickets({
        jiraClient: makeJira(), githubClient, config: makeConfig(), ...at(root), execGhPrView: vi.fn(async () => merged()), now: NOW,
      });
      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
      expect(result.errors).toEqual([]);
    });
  });
});
