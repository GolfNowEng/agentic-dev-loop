/**
 * Research-phase startup checks for `--phase research` while research still
 * runs from its v1 root (research-loop/) inside the monolith.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** ticket-refine's SKILL.md, relative to the research root. */
export const REFINE_SKILL_MD_PATH = ".claude/skills/ticket-refine/SKILL.md";

/**
 * Throws unless `root` has the ticket-refine skill. The spawned `claude -p`
 * resolves `/ticket-refine` (and its hooks) from its cwd, so a research
 * root without it would run every ticket against a missing skill -- fail
 * at startup instead, naming the path.
 */
export function assertResearchRoot(root: string): void {
  const skillPath = resolve(root, REFINE_SKILL_MD_PATH);
  if (!existsSync(skillPath)) {
    throw new Error(
      `--phase research: the ticket-refine skill was not found at ${skillPath}. ` +
        `The research root (PHASE_ROOT.research in src/main.ts) must contain ${REFINE_SKILL_MD_PATH}; ` +
        `update PHASE_ROOT if .claude/ moved.`,
    );
  }
}

/**
 * CLAUDE.md files the research spawn must not load. v1 research-loop ran
 * from its own repo, so only research-loop/CLAUDE.md (the skeptic stance)
 * loaded. Inside the monolith the research root is a subdirectory, and
 * Claude Code also loads every ancestor CLAUDE.md up to the repo root --
 * which here is dev's ("trust the ticket completely"), the opposite stance.
 * Returns the absolute CLAUDE.md path of every directory from `repoRoot`
 * down to, but excluding, the research root itself. Ancestors above the
 * repo root (e.g. ~/) are left alone: v1 loaded those too.
 */
export function researchClaudeMdExcludes(repoRoot: string, researchRoot: string): string[] {
  const absRepo = resolve(repoRoot);
  const absResearch = resolve(absRepo, researchRoot);
  const excludes: string[] = [];
  let dir = absResearch;
  while (dir !== absRepo && dir.startsWith(absRepo)) {
    const parent = resolve(dir, "..");
    excludes.unshift(join(parent, "CLAUDE.md"));
    dir = parent;
  }
  return excludes;
}
