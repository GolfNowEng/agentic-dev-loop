import { describe, expect, it } from "vitest";
import { atZero, type ResetStep, type SurveyedRow } from "../../../src/core/reset/step.ts";
import { renderTable } from "../../../src/core/reset/table.ts";

function row(area: ResetStep["area"], name: string, survey: SurveyedRow["survey"], error?: string): SurveyedRow {
  const r: SurveyedRow = { step: { area, name, survey: async () => survey }, survey };
  if (error !== undefined) r.error = error;
  return r;
}

describe("renderTable", () => {
  it("renders - for a null action and numbers rows from 1", () => {
    const out = renderTable("Reset T-1 (role: all)", [
      row("local", "run records", { found: "3 records", action: "archive 3", run: async () => {} }),
      row("git", "branches", { found: "none", action: null }),
    ]);
    expect(out).toBe(
      [
        "Reset T-1 (role: all)",
        "",
        "#  Area   Step         Found      Action",
        "1  local  run records  3 records  archive 3",
        "2  git    branches     none       -",
      ].join("\n"),
    );
  });

  it("renders needs you: <why>", () => {
    const out = renderTable("T", [row("jira", "comments", { found: "2", action: null, needsYou: "no credentials" })]);
    expect(out.split("\n")[3]).toBe("1  jira  comments  2      needs you: no credentials");
  });

  it("shows needs you: <error> for a row with error", () => {
    const out = renderTable("T", [row("jira", "labels", { found: "?", action: null }, "boom")]);
    expect(out.split("\n")[3]).toBe("1  jira  labels  ?      needs you: boom");
  });

  it("prints details indented under the row", () => {
    const out = renderTable("T", [row("jira", "comments", { found: "2", action: "delete 2", details: ["a", "b"] })]);
    const lines = out.split("\n");
    expect(lines[4]).toBe("      a");
    expect(lines[5]).toBe("      b");
  });

  it("truncates a long Found to 48 chars with …", () => {
    const out = renderTable("T", [row("local", "x", { found: "y".repeat(60), action: null })]);
    expect(out.split("\n")[3]).toContain(`${"y".repeat(47)}…  -`);
    expect(out).not.toContain("y".repeat(48));
  });

  it("status replaces Action with done or failed", () => {
    const a = row("local", "a", { found: "1", action: "do", run: async () => {} });
    const b = row("git", "b", { found: "1", action: "do", run: async () => {} });
    const out = renderTable("T", [a, b], new Map([[a, "done"], [b, "failed: nope"]]));
    const lines = out.split("\n");
    expect(lines[3]).toMatch(/ {2}done$/);
    expect(lines[4]).toMatch(/ {2}failed: nope$/);
  });

  it("has no trailing whitespace", () => {
    const out = renderTable("T", [row("local", "a", { found: "1", action: null })]);
    for (const l of out.split("\n")) expect(l).toBe(l.trimEnd());
  });
});

describe("atZero", () => {
  it("is false for needsYou, error, or an action", () => {
    expect(atZero(row("local", "a", { found: "none", action: null }))).toBe(true);
    expect(atZero(row("local", "a", { found: "x", action: "do", run: async () => {} }))).toBe(false);
    expect(atZero(row("local", "a", { found: "x", action: null, needsYou: "why" }))).toBe(false);
    expect(atZero(row("local", "a", { found: "x", action: null }, "err"))).toBe(false);
  });
});
