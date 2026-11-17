// Text guard: the ticket-to-pr skill documents push=host, stops at
// ready_to_push in Phase 5, and lists the verdict fields the loop parses.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const text = readFileSync(join(ROOT, ".claude/skills/ticket-to-pr/SKILL.md"), "utf8");

function section(heading: string): string {
  const start = text.indexOf(`\n${heading}`);
  expect(start, `missing ${heading}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(heading.length).search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, heading.length + next);
}

describe("ticket-to-pr push=host", () => {
  it("documents push=host in Arguments", () => {
    const s = section("## Arguments");
    expect(s).toContain("push=host");
    expect(s).toContain("PUSH_MODE");
  });
  it("Phase 5 stops at ready_to_push under push=host", () => {
    const s = section("### Phase 5");
    expect(s).toContain("push=host");
    expect(s).toContain('outcome: "ready_to_push"');
    expect(s).toContain("git status --porcelain");
  });
  it("verdict schema lists branch, pr_title, pr_body", () => {
    const s = section("## verdict.json schema");
    for (const f of ["ready_to_push", "branch", "pr_title", "pr_body"]) expect(s).toContain(f);
  });
});
