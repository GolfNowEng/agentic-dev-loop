import { describe, expect, it } from "vitest";
import { appendRunLog, readRunLog, hasLandedRun, findOpenPrUrl } from "../../src/core/runs-log.ts";
import type { RunLogLine } from "../../src/core/types.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeLine(overrides: Partial<RunLogLine> = {}): RunLogLine {
  return {
    ticket: "PROJ-142",
    skill: "ticket-to-pr",
    skill_version: "abc1234",
    model: "sonnet",
    started: "2026-08-16T14:02:11Z",
    ended: "2026-08-16T14:19:40Z",
    outcome: "landed",
    phase_reached: "pr",
    red_confirmed: true,
    verify_loops: 2,
    retries: 0,
    failure_category: null,
    detail: "Implemented and merged cleanly.",
    pr: "https://github.com/org/repo/pull/1",
    cost_usd: 1.84,
    tokens: { in: 410000, out: 22000 },
    ...overrides,
  };
}

describe("appendRunLog", () => {
  it("appends exactly one valid JSON line matching the schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-log-test-"));
    const path = join(dir, "runs.jsonl");
    try {
      const line = makeLine();
      await appendRunLog(path, line);

      const raw = await readFile(path, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed).toEqual(line);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is append-only: multiple calls add lines without rewriting prior ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-log-test-"));
    const path = join(dir, "runs.jsonl");
    try {
      const first = makeLine({ ticket: "PROJ-1" });
      const second = makeLine({ ticket: "PROJ-2" });
      const third = makeLine({ ticket: "PROJ-3" });

      await appendRunLog(path, first);
      const afterFirst = await readFile(path, "utf8");

      await appendRunLog(path, second);
      const afterSecond = await readFile(path, "utf8");
      // The bytes written for the first call must still be present,
      // untouched, as a prefix after the second call.
      expect(afterSecond.startsWith(afterFirst)).toBe(true);

      await appendRunLog(path, third);

      const lines = await readRunLog(path);
      expect(lines.map((l) => l.ticket)).toEqual([
        "PROJ-1",
        "PROJ-2",
        "PROJ-3",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produces one line per run - no batching, no merging", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-log-test-"));
    const path = join(dir, "runs.jsonl");
    try {
      await appendRunLog(path, makeLine({ ticket: "PROJ-10" }));
      await appendRunLog(path, makeLine({ ticket: "PROJ-11" }));

      const raw = await readFile(path, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(2);
      for (const l of lines) {
        expect(() => JSON.parse(l)).not.toThrow();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("every appended line has all schema fields with correct types", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-log-test-"));
    const path = join(dir, "runs.jsonl");
    try {
      await appendRunLog(path, makeLine());
      const [line] = await readRunLog(path);

      expect(typeof line.ticket).toBe("string");
      expect(typeof line.skill).toBe("string");
      expect(typeof line.skill_version).toBe("string");
      expect(typeof line.model).toBe("string");
      expect(typeof line.started).toBe("string");
      expect(typeof line.ended).toBe("string");
      expect(["landed", "bounced", "error", "killed"]).toContain(
        line.outcome,
      );
      expect(["intake", "plan", "red", "green", "verify", "pr"]).toContain(
        line.phase_reached,
      );
      expect(typeof line.red_confirmed).toBe("boolean");
      expect(typeof line.verify_loops).toBe("number");
      expect(typeof line.retries).toBe("number");
      expect(line.failure_category === null || typeof line.failure_category === "string").toBe(true);
      expect(typeof line.detail).toBe("string");
      expect(line.pr === null || typeof line.pr === "string").toBe(true);
      expect(typeof line.cost_usd).toBe("number");
      expect(typeof line.tokens.in).toBe("number");
      expect(typeof line.tokens.out).toBe("number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("hasLandedRun", () => {
  it("is false when the runs file does not exist", async () => {
    expect(await hasLandedRun("/nonexistent/runs.jsonl", "PROJ-1")).toBe(false);
  });

  it("is true only for a landed line on that ticket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-log-landed-"));
    const file = join(dir, "runs.jsonl");
    try {
      await appendRunLog(file, makeLine({ ticket: "PROJ-1", outcome: "bounced", pr: null }));
      await appendRunLog(file, makeLine({ ticket: "PROJ-2", outcome: "landed" }));
      expect(await hasLandedRun(file, "PROJ-1")).toBe(false);
      expect(await hasLandedRun(file, "PROJ-2")).toBe(true);
      await appendRunLog(file, makeLine({ ticket: "PROJ-1", outcome: "landed" }));
      expect(await hasLandedRun(file, "PROJ-1")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function withRunsLogFile(lines: RunLogLine[], fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "runs-log-test-"));
  const path = join(dir, "runs.jsonl");
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("findOpenPrUrl", () => {
  it("returns the PR URL from a 'landed' line", async () => {
    await withRunsLogFile(
      [makeLine({ ticket: "PROJ-1", outcome: "landed", pr: "https://github.com/org/repo/pull/9" })],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBe("https://github.com/org/repo/pull/9");
      },
    );
  });

  it("returns the PR URL from a 'bounced' line too -- intake finding a pre-existing PR still counts as an open PR to close on reset", async () => {
    await withRunsLogFile(
      [
        makeLine({ ticket: "PROJ-1",
          outcome: "bounced",
          pr: "https://github.com/org/repo/pull/431",
          failure_category: "blocked",
        }),
      ],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBe("https://github.com/org/repo/pull/431");
      },
    );
  });

  it("returns the most recent matching line's PR when several exist, landed and bounced mixed", async () => {
    await withRunsLogFile(
      [
        makeLine({ ticket: "PROJ-1", outcome: "landed", pr: "https://github.com/org/repo/pull/1", started: "2026-01-01T00:00:00.000Z" }),
        makeLine({ ticket: "PROJ-1", outcome: "bounced", pr: "https://github.com/org/repo/pull/1", failure_category: "blocked", started: "2026-01-01T00:05:00.000Z" }),
        makeLine({ ticket: "PROJ-1", outcome: "bounced", pr: "https://github.com/org/repo/pull/1", failure_category: "blocked", started: "2026-01-01T00:10:00.000Z" }),
      ],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBe("https://github.com/org/repo/pull/1");
      },
    );
  });

  it("ignores a bounced line with no PR (a genuine blocker, never opened a PR)", async () => {
    await withRunsLogFile(
      [
        makeLine({ ticket: "PROJ-1",
          outcome: "bounced",
          pr: null,
          failure_category: "spec_ambiguous",
        }),
      ],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBeNull();
      },
    );
  });

  it("returns null when no line matches the ticket key", async () => {
    await withRunsLogFile(
      [makeLine({ ticket: "PROJ-OTHER" })],
      async (runsLogPath) => {
        const url = await findOpenPrUrl(runsLogPath, "PROJ-1");
        expect(url).toBeNull();
      },
    );
  });

  it("returns null when the runs.jsonl file doesn't exist", async () => {
    const url = await findOpenPrUrl("/nonexistent/runs.jsonl", "PROJ-1");
    expect(url).toBeNull();
  });
});
