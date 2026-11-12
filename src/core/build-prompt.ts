// The one place a skill invocation is built (spec §6.5: the runner passes
// each skill its run directory, skills never derive it). Every value in the
// prompt is validated here, so nothing from a ticket can add an argument:
//
//   /<skill> <KEY> run-dir=<abs RUN_DIR> repo-dir=<abs REPO_DIR>
//
// The skills refuse (agent_error, no files written) a run-dir that is not
// absolute or has no `/.pipeline/v2/` in it. This side refuses first.

import { isAbsolute, normalize } from "node:path";
import type { Config, Role, RoleLimits } from "./types.ts";
import { RUN_ID, TICKET_KEY, UnsafePathError, resolveRepoPath, v2CloneDir } from "./paths.ts";

export const SKILL_NAME: Record<Role, string> = { research: "ticket-refine", dev: "ticket-to-pr" };

export interface SkillPromptArgs {
  role: Role;
  ticketKey: string;
  /** Absolute RUN_DIR: resolveRepoPath(v2RunDir(...)). */
  runDir: string;
  /** Absolute REPO_DIR: repoDirFor(config, slug). */
  repoDir: string;
}

function absPath(label: string, value: string): string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new UnsafePathError(`${label} ${JSON.stringify(value)} must be a non-empty path with no whitespace`);
  }
  if (!isAbsolute(value) || normalize(value) !== value || value.split("/").includes("..")) {
    throw new UnsafePathError(`${label} ${JSON.stringify(value)} must be absolute and normalized`);
  }
  return value;
}

export function buildSkillPrompt({ role, ticketKey, runDir, repoDir }: SkillPromptArgs): string {
  const skill = SKILL_NAME[role];
  if (skill === undefined) throw new UnsafePathError(`role ${JSON.stringify(role)} has no skill`);
  if (typeof ticketKey !== "string" || !TICKET_KEY.test(ticketKey)) {
    throw new UnsafePathError(`ticket key ${JSON.stringify(ticketKey)} must match ${TICKET_KEY}`);
  }
  absPath("run-dir", runDir);
  absPath("repo-dir", repoDir);
  if (!runDir.includes("/.pipeline/v2/")) {
    throw new UnsafePathError(`run-dir ${JSON.stringify(runDir)} must be under .pipeline/v2/`);
  }
  // The run dir is <...>/<ticket>/<role>-<RUN_ID>: it must be this ticket's and this role's.
  const [ticketSeg, last] = runDir.split("/").slice(-2);
  const prefix = `${role}-`;
  if (ticketSeg !== ticketKey || !last.startsWith(prefix) || !RUN_ID.test(last.slice(prefix.length))) {
    throw new UnsafePathError(`run-dir ${JSON.stringify(runDir)} must end in /${ticketKey}/${prefix}<RUN_ID>`);
  }
  return `/${skill} ${ticketKey} run-dir=${runDir} repo-dir=${repoDir}`;
}

/** REPO_DIR: `targetRepo.path` when set, else the absolute v2 clone dir (the skill clones it if missing). */
export function repoDirFor(config: Config, slug: string): string {
  return config.targetRepo.path ?? resolveRepoPath(v2CloneDir(slug));
}

/**
 * The env a role's claude spawns with (spawn-claude's childEnv() then strips
 * the JIRA_* creds). The CLI's own background-task wait ceiling follows the
 * role's runTimeoutMin, computed from config so the two never drift: without
 * it a long subagent gets the whole headless session killed at the CLI's
 * 600 s default, long before runTimeoutMin.
 */
export function claudeEnvFor(limits: RoleLimits, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...parent, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(limits.runTimeoutMin * 60_000) };
}
