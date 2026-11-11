import { describe, expect, it } from "vitest";
import {
  agentErrorVerdict,
  errorVerdict,
  parseSizeTrajectory,
  parseVerdict,
  readVerdict,
  readVerdictFile,
} from "../../src/core/verdict.ts";
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

// research-loop's verdict schema (ticket-refine): only outcome/phase_reached/
// failure_category/detail are required, and "ready" is a valid outcome. This
// is the default ("refine") profile.
const minimalRefineVerdict = {
  outcome: "ready",
  phase_reached: "verify",
  failure_category: null,
  detail: "Refined ticket written.",
};

describe("parseVerdict: default (refine) profile", () => {
  it("parses a verdict carrying only the four required fields", () => {
    const verdict = parseVerdict(JSON.stringify({ ...minimalRefineVerdict, outcome: "landed" }));
    expect(verdict.outcome).toBe("landed");
    expect(verdict.failure_category).toBeNull();
  });

  it("parses outcome \"ready\" -- ticket-refine's own passing verdict", () => {
    const verdict = parseVerdict(JSON.stringify(minimalRefineVerdict));
    expect(verdict.outcome).toBe("ready");
  });

  it("keeps a well-formed size_trajectory", () => {
    const traj = { step4_tshirt: "M", delta: "unchanged", final_score: 4.5 };
    const verdict = parseVerdict(JSON.stringify({ ...minimalRefineVerdict, size_trajectory: traj }));
    expect(verdict.size_trajectory).toEqual(traj);
  });

  it("drops a malformed size_trajectory without flipping outcome to error", () => {
    const verdict = parseVerdict(
      JSON.stringify({
        ...minimalRefineVerdict,
        size_trajectory: { step4_tshirt: "NOT_VALID", delta: "grew", final_score: 999 },
      }),
    );
    expect(verdict.outcome).toBe("ready");
    expect(verdict.size_trajectory).toBeUndefined();
  });
});

// ticket-to-pr's schema: the dev role reads every executor field
// unconditionally (verdict.pr !== null picks the bounce branch), so the
// "executor" profile keeps dev-loop's original strict shape check.
describe("parseVerdict: executor profile", () => {
  it("parses a full ticket-to-pr verdict", () => {
    const verdict = parseVerdict(validVerdictJson, "executor");
    expect(verdict.outcome).toBe("landed");
    expect(verdict.pr).toBe("https://github.com/org/repo/pull/1");
  });

  it("rejects a verdict missing an executor field as agent_error", () => {
    const { pr: _pr, ...withoutPr } = JSON.parse(validVerdictJson);
    const verdict = parseVerdict(JSON.stringify(withoutPr), "executor");
    expect(verdict.outcome).toBe("error");
    expect(verdict.failure_category).toBe("agent_error");
    expect(verdict.pr).toBeNull();
  });

  it("rejects outcome \"ready\" as agent_error", () => {
    const verdict = parseVerdict(
      JSON.stringify({ ...JSON.parse(validVerdictJson), outcome: "ready" }),
      "executor",
    );
    expect(verdict.outcome).toBe("error");
    expect(verdict.failure_category).toBe("agent_error");
  });

  it("readVerdictFile applies the executor profile when asked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verdict-test-"));
    const path = join(dir, "verdict.json");
    await writeFile(path, JSON.stringify(minimalRefineVerdict), "utf8");
    try {
      expect((await readVerdictFile(path)).outcome).toBe("ready");
      const strict = await readVerdictFile(path, "executor");
      expect(strict.outcome).toBe("error");
      expect(strict.failure_category).toBe("agent_error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("research-loop function names", () => {
  it("errorVerdict and readVerdict are the same functions as agentErrorVerdict and readVerdictFile", () => {
    expect(errorVerdict).toBe(agentErrorVerdict);
    expect(readVerdict).toBe(readVerdictFile);
  });
});

describe("parseSizeTrajectory", () => {
  it("parses a well-formed size_trajectory", () => {
    const result = parseSizeTrajectory({
      step4_tshirt: "M",
      delta: "unchanged",
      final_score: 4.5,
    });
    expect(result).toEqual({
      step4_tshirt: "M",
      delta: "unchanged",
      final_score: 4.5,
    });
  });

  it("returns null for a non-object value", () => {
    expect(parseSizeTrajectory(undefined)).toBeNull();
    expect(parseSizeTrajectory(null)).toBeNull();
    expect(parseSizeTrajectory("not an object")).toBeNull();
    expect(parseSizeTrajectory(42)).toBeNull();
  });

  it("returns null for an invalid step4_tshirt value", () => {
    expect(
      parseSizeTrajectory({ step4_tshirt: "XXL", delta: "grew", final_score: 5 }),
    ).toBeNull();
  });

  it("returns null for an invalid delta value", () => {
    expect(
      parseSizeTrajectory({ step4_tshirt: "S", delta: "exploded", final_score: 5 }),
    ).toBeNull();
  });

  it("returns null for a non-finite final_score", () => {
    expect(
      parseSizeTrajectory({ step4_tshirt: "S", delta: "grew", final_score: NaN }),
    ).toBeNull();
    expect(
      parseSizeTrajectory({ step4_tshirt: "S", delta: "grew", final_score: Infinity }),
    ).toBeNull();
  });

  it("returns null for a final_score outside [0, 10]", () => {
    expect(
      parseSizeTrajectory({ step4_tshirt: "S", delta: "grew", final_score: -0.1 }),
    ).toBeNull();
    expect(
      parseSizeTrajectory({ step4_tshirt: "S", delta: "grew", final_score: 10.1 }),
    ).toBeNull();
  });

  it("accepts the boundary values 0 and 10", () => {
    expect(
      parseSizeTrajectory({ step4_tshirt: "S", delta: "grew", final_score: 0 }),
    ).not.toBeNull();
    expect(
      parseSizeTrajectory({ step4_tshirt: "XL", delta: "shrank", final_score: 10 }),
    ).not.toBeNull();
  });

  it("never throws on a malformed value", () => {
    expect(() => parseSizeTrajectory("garbage")).not.toThrow();
    expect(() => parseSizeTrajectory({})).not.toThrow();
  });

  it("does not affect isValidVerdictShape/parseVerdict -- a malformed size_trajectory never flips outcome to error", () => {
    const raw = JSON.stringify({
      outcome: "ready",
      phase_reached: "verify",
      failure_category: null,
      detail: "Refined ticket written.",
      size_trajectory: { step4_tshirt: "NOT_VALID", delta: "grew", final_score: 999 },
    });
    const verdict = parseVerdict(raw);
    expect(verdict.outcome).toBe("ready");
  });
});

