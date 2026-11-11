import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RESEARCH_STANCE_PATH,
  REFINE_SKILL_MD_PATH,
  loadResearchStance,
  researchClaudeMdExcludes,
} from "../../../src/roles/research/startup.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

// Both roles spawn from the repo root (Ruling 22). The root CLAUDE.md is
// dev's "trust the ticket completely" stance, so the research spawn excludes
// it and gets the skeptic stance through --append-system-prompt instead.
describe("researchClaudeMdExcludes", () => {
  it("excludes the repo root's CLAUDE.md, absolute", () => {
    expect(researchClaudeMdExcludes("/abs/dev-loop")).toEqual(["/abs/dev-loop/CLAUDE.md"]);
  });

  it("resolves a relative root", () => {
    expect(researchClaudeMdExcludes(".")).toEqual([resolve("CLAUDE.md")]);
  });
});

describe("research stance", () => {
  it("lives in the repo at RESEARCH_STANCE_PATH, next to the research role", () => {
    expect(RESEARCH_STANCE_PATH).toBe("src/roles/research/stance.md");
  });

  it("is the skeptic stance, not the executor's", async () => {
    const stance = await loadResearchStance(REPO_ROOT);
    expect(stance).toContain("Treat every raw ticket as an unverified claim");
    expect(stance).toContain("A bounce is a success, not a failure");
    expect(stance).not.toContain("Trust the ticket completely");
  });

  it("is what the file says, byte for byte", async () => {
    expect(await loadResearchStance(REPO_ROOT)).toBe(readFileSync(resolve(REPO_ROOT, RESEARCH_STANCE_PATH), "utf8"));
  });

  it("throws, naming the path, when the file is missing", async () => {
    await expect(loadResearchStance("/nonexistent-root")).rejects.toThrow(/stance\.md/);
  });

  it("REFINE_SKILL_MD_PATH is repo-root-relative and exists", () => {
    expect(() => readFileSync(resolve(REPO_ROOT, REFINE_SKILL_MD_PATH))).not.toThrow();
  });
});
