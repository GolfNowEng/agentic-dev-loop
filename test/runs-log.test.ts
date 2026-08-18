import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendRunLog, readRunLog, countRunsToday } from "../src/runs-log.js";
import type { RunLogLine } from "../src/types.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function makeLine(overrides: Partial<RunLogLine> = {}): RunLogLine {
  return {
    ticket: "PROJ-142",
    skill: "ticket-refine",
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
    detail: "Landed cleanly.",
    pr: "https://github.com/example/repo/pull/1",
    cost_usd: 1.84,
    tokens: { in: 410000, out: 22000 },
    ...overrides,
  };
}

describe("appendRunLog", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "runs-log-test-"));
    filePath = path.join(dir, "runs.jsonl");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("appends exactly one JSON line per call", async () => {
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-1" }));
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it("every appended line is valid JSON matching the RunLogLine schema", async () => {
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-1" }));
    const [line] = await readRunLog(filePath);
    expect(line.ticket).toBe("PROJ-1");
    expect(line.skill).toBe("ticket-refine");
    expect(line.skill_version).toBe("abc1234");
    expect(line.model).toBe("sonnet");
    expect(line.started).toBe("2026-08-16T14:02:11Z");
    expect(line.ended).toBe("2026-08-16T14:19:40Z");
    expect(line.outcome).toBe("landed");
    expect(line.phase_reached).toBe("pr");
    expect(line.red_confirmed).toBe(true);
    expect(line.verify_loops).toBe(2);
    expect(line.retries).toBe(0);
    expect(line.failure_category).toBeNull();
    expect(typeof line.detail).toBe("string");
    expect(line.pr).toBe("https://github.com/example/repo/pull/1");
    expect(line.cost_usd).toBe(1.84);
    expect(line.tokens).toEqual({ in: 410000, out: 22000 });
  });

  it("appends multiple runs as separate lines, one per run, in call order", async () => {
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-1" }));
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-2" }));
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-3" }));
    const lines = await readRunLog(filePath);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.ticket)).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
  });

  it("never rewrites prior lines -- earlier lines are untouched by later appends", async () => {
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-1", cost_usd: 1.0 }));
    const contentAfterFirst = await fs.readFile(filePath, "utf8");
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-2", cost_usd: 2.0 }));
    const contentAfterSecond = await fs.readFile(filePath, "utf8");
    expect(contentAfterSecond.startsWith(contentAfterFirst)).toBe(true);
  });
});

describe("countRunsToday", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "runs-log-count-test-"));
    filePath = path.join(dir, "runs.jsonl");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns 0 when the file does not exist yet", async () => {
    const count = await countRunsToday(filePath, new Date("2026-08-16T12:00:00Z"));
    expect(count).toBe(0);
  });

  it("counts only lines whose started falls on the same UTC calendar day as now", async () => {
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-1", started: "2026-08-16T00:00:01Z" }));
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-2", started: "2026-08-16T23:59:59Z" }));
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-3", started: "2026-08-15T23:59:59Z" }));
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-4", started: "2026-08-17T00:00:00Z" }));

    const count = await countRunsToday(filePath, new Date("2026-08-16T12:00:00Z"));
    expect(count).toBe(2);
  });

  it("returns 0 when no lines match the given day", async () => {
    await appendRunLog(filePath, makeLine({ ticket: "PROJ-1", started: "2026-08-15T12:00:00Z" }));
    const count = await countRunsToday(filePath, new Date("2026-08-16T12:00:00Z"));
    expect(count).toBe(0);
  });
});
