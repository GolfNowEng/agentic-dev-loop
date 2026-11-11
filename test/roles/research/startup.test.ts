import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertResearchRoot,
  researchClaudeMdExcludes,
  REFINE_SKILL_MD_PATH,
} from "../../../src/roles/research/startup.ts";

describe("assertResearchRoot", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "research-root-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("throws a clear error naming the missing ticket-refine SKILL.md", () => {
    expect(() => assertResearchRoot(dir)).toThrow(
      new RegExp(`ticket-refine.*not found.*${join(dir, ".claude/skills/ticket-refine/SKILL.md").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`),
    );
  });

  it("does not throw when the skill is present", async () => {
    await mkdir(join(dir, ".claude/skills/ticket-refine"), { recursive: true });
    await writeFile(join(dir, REFINE_SKILL_MD_PATH), "# skill", "utf8");
    expect(() => assertResearchRoot(dir)).not.toThrow();
  });

  it("holds for the real PHASE_ROOT today (research-loop/)", () => {
    expect(() => assertResearchRoot("research-loop")).not.toThrow();
  });
});

// v1 research-loop ran claude -p from its own repo, so only
// research-loop/CLAUDE.md (the skeptic stance) loaded. Inside the monolith
// the research cwd is a subdirectory, and Claude Code also loads ancestor
// CLAUDE.md files -- dev's "trust the ticket completely". The research
// spawn excludes every CLAUDE.md above its root.
describe("researchClaudeMdExcludes", () => {
  it("excludes the repo root's CLAUDE.md, absolute", () => {
    expect(researchClaudeMdExcludes("/abs/dev-loop", "research-loop")).toEqual([
      "/abs/dev-loop/CLAUDE.md",
    ]);
  });

  it("never excludes the research root's own CLAUDE.md", () => {
    const excl = researchClaudeMdExcludes("/abs/dev-loop", "research-loop");
    expect(excl).not.toContain("/abs/dev-loop/research-loop/CLAUDE.md");
  });

  it("excludes nothing when the research root is the repo root (after Task 5/6 merges it)", () => {
    expect(researchClaudeMdExcludes("/abs/dev-loop", ".")).toEqual([]);
  });
});
