// Text guard: the skills and agents work on the loop's fake env (built from
// .envrc.example, src/core/fake-env.ts), never the target repo's real
// .envrc. New settings go into .envrc.example with fake values and are named
// in the PR; a setting the fake lacks is a bounce, never a guess.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const FILES = {
  toPr: ".claude/skills/ticket-to-pr/SKILL.md",
  refine: ".claude/skills/ticket-refine/SKILL.md",
  recon: ".claude/agents/recon-agent.md",
  qa: ".claude/agents/qa-agent.md",
};

describe("the robot works on the loop's fake env", () => {
  for (const [k, p] of Object.entries(FILES)) {
    it(`${k}: no longer says the worktree picks up the real .envrc, and names the fake env`, () => {
      const t = read(p);
      expect(t).not.toMatch(/real local/i);
      expect(t).not.toMatch(/picks? up (its|the target repo's|the target repo’s) (own )?(real )?`?\.envrc/i);
      expect(t).toContain("fake env");
    });
  }

  for (const k of ["toPr", "refine"] as const) {
    it(`${k}: never read the real env files, never copy the example over them`, () => {
      const t = read(FILES[k]);
      expect(t).toContain("Never read `<REPO_DIR>/.envrc`");
      expect(t).toMatch(/never copy `\.envrc\.example` to a `\.envrc`/i);
    });
  }

  it("ticket-to-pr: new settings go to .envrc.example and are named in the PR body", () => {
    const t = read(FILES.toPr);
    expect(t).toContain("New settings:");
    expect(t).toContain("add the real INT value to your .envrc");
    expect(t).toMatch(/env NAME=<fake value>/);
  });

  it("ticket-to-pr: a setting the fake lacks, that the ticket isn't adding, bounces env_setup", () => {
    const t = read(FILES.toPr);
    expect(t).toMatch(/setting[^.]*\.envrc\.example[^.]*bounce[^.]*"env_setup"/is);
  });
});
