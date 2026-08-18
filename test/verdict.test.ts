import { describe, it, expect } from "vitest";
import { parseVerdict, readVerdict, errorVerdict } from "../src/verdict.ts";
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

describe("errorVerdict", () => {
  it("produces a Verdict with outcome error and failure_category agent_error", () => {
    const verdict = errorVerdict("verdict.json missing");
    expect(verdict.outcome).toBe("error");
    expect(verdict.failure_category).toBe("agent_error");
    expect(verdict.detail).toContain("verdict.json missing");
  });
});
