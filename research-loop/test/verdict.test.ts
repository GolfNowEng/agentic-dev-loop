import { describe, it, expect } from "vitest";
import { parseVerdict, readVerdict, errorVerdict, parseSizeTrajectory } from "../src/verdict.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("parseVerdict", () => {
  it("parses a well-formed verdict.json body", () => {
    const raw = JSON.stringify({
      outcome: "landed",
      phase_reached: "pr",
      failure_category: null,
      detail: "Landed cleanly.",
      pr: "https://github.com/example/repo/pull/1",
    });
    const verdict = parseVerdict(raw);
    expect(verdict.outcome).toBe("landed");
    expect(verdict.phase_reached).toBe("pr");
    expect(verdict.failure_category).toBeNull();
  });

  it("parses outcome \"ready\" -- ticket-refine's own passing verdict, distinct from the shared RunOutcome enum", () => {
    const raw = JSON.stringify({
      outcome: "ready",
      phase_reached: "verify",
      failure_category: null,
      detail: "Refined ticket written.",
    });
    const verdict = parseVerdict(raw);
    expect(verdict.outcome).toBe("ready");
    expect(verdict.failure_category).toBeNull();
  });

  it("never throws on undefined input, and treats it as agent_error", () => {
    let verdict;
    expect(() => {
      verdict = parseVerdict(undefined);
    }).not.toThrow();
    expect(verdict!.outcome).toBe("error");
    expect(verdict!.failure_category).toBe("agent_error");
  });

  it("never throws on null input, and treats it as agent_error", () => {
    let verdict;
    expect(() => {
      verdict = parseVerdict(null);
    }).not.toThrow();
    expect(verdict!.outcome).toBe("error");
    expect(verdict!.failure_category).toBe("agent_error");
  });

  it("never throws on malformed JSON, and treats it as agent_error", () => {
    let verdict;
    expect(() => {
      verdict = parseVerdict("{ this is not valid json ::");
    }).not.toThrow();
    expect(verdict!.outcome).toBe("error");
    expect(verdict!.failure_category).toBe("agent_error");
  });

  it("never throws on JSON missing required fields, and treats it as agent_error", () => {
    let verdict;
    expect(() => {
      verdict = parseVerdict(JSON.stringify({ some: "unrelated shape" }));
    }).not.toThrow();
    expect(verdict!.outcome).toBe("error");
    expect(verdict!.failure_category).toBe("agent_error");
  });
});

describe("readVerdict", () => {
  it("reads and parses a valid verdict.json file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verdict-test-"));
    const filePath = path.join(dir, "verdict.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        outcome: "bounced",
        phase_reached: "verify",
        failure_category: "verify_rejected",
        detail: "Verification rejected the change.",
      }),
      "utf8",
    );
    const verdict = await readVerdict(filePath);
    expect(verdict.outcome).toBe("bounced");
    expect(verdict.failure_category).toBe("verify_rejected");
  });

  it("never throws when the file is missing, and treats it as agent_error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verdict-test-"));
    const filePath = path.join(dir, "does-not-exist.json");
    let verdict;
    await expect(
      (async () => {
        verdict = await readVerdict(filePath);
      })(),
    ).resolves.not.toThrow();
    expect(verdict!.outcome).toBe("error");
    expect(verdict!.failure_category).toBe("agent_error");
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

describe("errorVerdict", () => {
  it("produces a Verdict with outcome error and failure_category agent_error", () => {
    const verdict = errorVerdict("verdict.json missing");
    expect(verdict.outcome).toBe("error");
    expect(verdict.failure_category).toBe("agent_error");
    expect(verdict.detail).toContain("verdict.json missing");
  });
});
