import { describe, it, expect } from "vitest";
import { extractUsage } from "../src/claude-usage.js";

describe("extractUsage", () => {
  it("extracts cost and combines input-token fields per the confirmed claude -p --output-format json shape", () => {
    const raw = {
      total_cost_usd: 0.272931,
      usage: {
        input_tokens: 7297,
        cache_creation_input_tokens: 66916,
        cache_read_input_tokens: 0,
        output_tokens: 7,
      },
    };
    const usage = extractUsage(raw);
    expect(usage.costUsd).toBe(0.272931);
    expect(usage.tokens).toEqual({ in: 7297 + 66916 + 0, out: 7 });
  });

  it("treats missing cache token fields as zero", () => {
    const raw = {
      total_cost_usd: 1.5,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const usage = extractUsage(raw);
    expect(usage.costUsd).toBe(1.5);
    expect(usage.tokens).toEqual({ in: 100, out: 50 });
  });

  it("returns zeros for null input", () => {
    expect(extractUsage(null)).toEqual({ costUsd: 0, tokens: { in: 0, out: 0 } });
  });

  it("returns zeros for undefined input", () => {
    expect(extractUsage(undefined)).toEqual({ costUsd: 0, tokens: { in: 0, out: 0 } });
  });

  it("returns zeros for a non-object input", () => {
    expect(extractUsage("not json")).toEqual({ costUsd: 0, tokens: { in: 0, out: 0 } });
  });

  it("returns zeros when total_cost_usd is missing or not a number", () => {
    const usage = extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } });
    expect(usage.costUsd).toBe(0);
    expect(usage.tokens).toEqual({ in: 10, out: 5 });
  });

  it("returns zero tokens when usage is missing entirely", () => {
    const usage = extractUsage({ total_cost_usd: 2.0 });
    expect(usage.costUsd).toBe(2.0);
    expect(usage.tokens).toEqual({ in: 0, out: 0 });
  });

  it("never throws on malformed input", () => {
    expect(() => extractUsage({ usage: "not an object" })).not.toThrow();
    expect(() => extractUsage(42)).not.toThrow();
    expect(() => extractUsage([1, 2, 3])).not.toThrow();
  });
});
