/**
 * Research-phase spawn setup. Both roles spawn `claude -p` from the repo
 * root (Ruling 22), so Claude Code would load the root CLAUDE.md -- dev's
 * "trust the ticket completely", the opposite stance. The research spawn
 * excludes it (claudeMdExcludes, via --settings) and gets the skeptic stance
 * from `stance.md` through --append-system-prompt instead (a Claude Code
 * flag, verified in 2.1.322).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** ticket-refine's SKILL.md, relative to the repo root. */
export const REFINE_SKILL_MD_PATH = ".claude/skills/ticket-refine/SKILL.md";

/** The research stance, relative to the repo root. */
export const RESEARCH_STANCE_PATH = "src/roles/research/stance.md";

/** CLAUDE.md files the research spawn must not load: the repo root's (absolute). */
export function researchClaudeMdExcludes(repoRoot: string): string[] {
  return [join(resolve(repoRoot), "CLAUDE.md")];
}

/** The research stance text, read at startup. Throws (naming the path) if it is missing. */
export async function loadResearchStance(repoRoot: string): Promise<string> {
  const path = resolve(repoRoot, RESEARCH_STANCE_PATH);
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`the research stance file ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}
