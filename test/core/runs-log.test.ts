import { describe, expect, it } from "vitest";
import { appendRunLog, readRunLog, countRunsToday } from "../../src/core/runs-log.ts";
import type { RunLogLine } from "../../src/core/types.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

describe("countRunsToday", () => {
  it("returns 0 when the file does not exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-log-count-test-"));
    const path = join(dir, "runs.jsonl");
    try {
      const count = await countRunsToday(path, new Date("2026-08-16T12:00:00Z"));
      expect(count).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts only lines whose started falls on the same UTC calendar day as now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-log-count-test-"));
    const path = join(dir, "runs.jsonl");
    try {
      await appendRunLog(path, makeLine({ ticket: "PROJ-1", started: "2026-08-16T00:00:01Z" }));
      await appendRunLog(path, makeLine({ ticket: "PROJ-2", started: "2026-08-16T23:59:59Z" }));
      await appendRunLog(path, makeLine({ ticket: "PROJ-3", started: "2026-08-15T23:59:59Z" }));
      await appendRunLog(path, makeLine({ ticket: "PROJ-4", started: "2026-08-17T00:00:00Z" }));

      const count = await countRunsToday(path, new Date("2026-08-16T12:00:00Z"));
      expect(count).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 when no lines match the given day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-log-count-test-"));
    const path = join(dir, "runs.jsonl");
    try {
      await appendRunLog(path, makeLine({ ticket: "PROJ-1", started: "2026-08-15T12:00:00Z" }));
      const count = await countRunsToday(path, new Date("2026-08-16T12:00:00Z"));
      expect(count).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
