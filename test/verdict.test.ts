import { describe, expect, it } from "vitest";
import {
  agentErrorVerdict,
  parseVerdict,
  readVerdictFile,
} from "../src/verdict.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const validVerdictJson = JSON.stringify({
  outcome: "landed",
  phase_reached: "pr",
  failure_category: null,
  detail: "Implemented and merged cleanly.",
  red_confirmed: true,
  verify_loops: 1,
  retries: 0,
  skill_version: "abc1234",
  model: "sonnet",
  pr: "https://github.com/org/repo/pull/1",
  cost_usd: 1.23,
  tokens: { in: 1000, out: 200 },
});

describe("parseVerdict", () => {
  it("parses a well-formed verdict.json string", () => {
    const verdict = parseVerdict(validVerdictJson);
    expect(verdict.outcome).toBe("landed");
    expect(verdict.phase_reached).toBe("pr");
    expect(verdict.failure_category).toBeNull();
  });

  it("never throws on missing input (null)", () => {
    expect(() => parseVerdict(null)).not.toThrow();
  });

  it("never throws on missing input (undefined)", () => {
    expect(() => parseVerdict(undefined)).not.toThrow();
  });

  it("treats missing input as outcome error / failure_category agent_error", () => {
    const verdict = parseVerdict(null);
    expect(verdict.outcome).toBe("error");
    expect(verdict.failure_category).toBe("agent_error");
  });

  it("never throws on malformed JSON", () => {
    expect(() => parseVerdict("{not valid json")).not.toThrow();
  });

  it("treats malformed JSON as outcome error / failure_category agent_error", () => {
    const verdict = parseVerdict("{not valid json");
    expect(verdict.outcome).toBe("error");
    expect(verdict.failure_category).toBe("agent_error");
  });

  it("never throws on valid JSON with the wrong shape", () => {
    expect(() => parseVerdict(JSON.stringify({ foo: "bar" }))).not.toThrow();
  });

  it("treats wrong-shape JSON as outcome error / failure_category agent_error", () => {
    const verdict = parseVerdict(JSON.stringify({ foo: "bar" }));
    expect(verdict.outcome).toBe("error");
    expect(verdict.failure_category).toBe("agent_error");
  });
});

describe("parseVerdict: qa_notes (optional manual-testing-steps field)", () => {
  it("accepts a verdict with qa_notes present as an array of strings", () => {
    const json = JSON.stringify({
      ...JSON.parse(validVerdictJson),
      qa_notes: [
        "Navigate to `/rotten-tomatoes/critics?query=tina+kakad`",
        "Expected: the Self-Service badge appears next to the critic's name",
      ],
    });
    const verdict = parseVerdict(json);
    expect(verdict.outcome).toBe("landed");
    expect(verdict.qa_notes).toEqual([
      "Navigate to `/rotten-tomatoes/critics?query=tina+kakad`",
      "Expected: the Self-Service badge appears next to the critic's name",
    ]);
  });

  it("accepts a verdict with qa_notes absent -- back-compat with verdicts written before this field existed", () => {
    const verdict = parseVerdict(validVerdictJson);
    expect(verdict.outcome).toBe("landed");
    expect(verdict.qa_notes).toBeUndefined();
  });
});

describe("agentErrorVerdict", () => {
  it("builds a canonical error verdict with the given detail", () => {
    const verdict = agentErrorVerdict("verdict.json was missing");
    expect(verdict.outcome).toBe("error");
    expect(verdict.failure_category).toBe("agent_error");
    expect(verdict.detail).toBe("verdict.json was missing");
  });
});

describe("readVerdictFile", () => {
  it("parses a valid verdict.json file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-test-"));
    const path = join(dir, "verdict.json");
    await writeFile(path, validVerdictJson, "utf8");
    try {
      const verdict = await readVerdictFile(path);
      expect(verdict.outcome).toBe("landed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never rejects when the file is missing - resolves to an agent_error verdict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-test-"));
    const path = join(dir, "does-not-exist.json");
    try {
      await expect(readVerdictFile(path)).resolves.toBeDefined();
      const verdict = await readVerdictFile(path);
      expect(verdict.outcome).toBe("error");
      expect(verdict.failure_category).toBe("agent_error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never rejects when the file is malformed - resolves to an agent_error verdict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-test-"));
    const path = join(dir, "verdict.json");
    await writeFile(path, "{not valid json", "utf8");
    try {
      const verdict = await readVerdictFile(path);
      expect(verdict.outcome).toBe("error");
      expect(verdict.failure_category).toBe("agent_error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
