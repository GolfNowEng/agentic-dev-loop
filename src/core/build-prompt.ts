// The one place a skill invocation is built (spec §6.5: the runner passes
// each skill its run directory, skills never derive it). Every value in the
// prompt is validated here, so nothing from a ticket can add an argument:
//
//   /<skill> <KEY> run-dir=<abs RUN_DIR> repo-dir=<abs REPO_DIR>
//
// The skills refuse (agent_error, no files written) a run-dir that is not
// absolute or has no `/.pipeline/v2/` in it. This side refuses first.

import { isAbsolute, normalize, relative } from "node:path";
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

/**
 * Characters a path in the prompt may contain. The skills paste REPO_DIR and
 * RUN_DIR unquoted into Bash (`git -C <REPO_DIR> fetch`), so this is an
 * allowlist, not a denylist: no whitespace, quotes, `;`, `$`, backticks,
 * globs or `\`. `@` stays allowed for an email-shaped $HOME.
 */
export const SAFE_PATH = /^[A-Za-z0-9@._/+-]+$/;

/** Throws UnsafePathError unless `value` is an absolute, normalized path of SAFE_PATH characters. */
export function checkAbsPath(label: string, value: string): string {
  if (typeof value !== "string" || !SAFE_PATH.test(value)) {
    throw new UnsafePathError(`${label} ${JSON.stringify(value)} must be a non-empty path of the characters ${SAFE_PATH}`);
  }
  if (!isAbsolute(value) || normalize(value) !== value || value.split("/").includes("..")) {
    throw new UnsafePathError(`${label} ${JSON.stringify(value)} must be absolute and normalized`);
  }
  return value;
}

/**
 * Throws UnsafePathError when REPO_DIR (absolute, already checkAbsPath'd)
 * sits wrong relative to the dev-loop root:
 *   - the root itself or an ancestor of it: research's Edit/Write deny
 *     under REPO_DIR would cover RUN_DIR, so every run would end with no
 *     verdict (agent_error), cost money, and get the ticket Blocked;
 *   - inside the root, except the v2 clone dir (`cloneDir`).
 * Startup calls it, so a misconfigured `targetRepo.path` exits 1.
 */
export function checkRepoDirPlacement(repoDir: string, devLoopRoot: string, cloneDir: string): string {
  const up = relative(repoDir, devLoopRoot);
  if (up === "") {
    throw new UnsafePathError(`repo-dir ${JSON.stringify(repoDir)} is the dev-loop root; point targetRepo.path at the target repo's own checkout`);
  }
  if (!up.startsWith("..") && !isAbsolute(up)) {
    throw new UnsafePathError(`repo-dir ${JSON.stringify(repoDir)} is an ancestor of the dev-loop root; research's edit deny would cover its run dirs`);
  }
  const down = relative(devLoopRoot, repoDir);
  if (repoDir !== cloneDir && !down.startsWith("..") && !isAbsolute(down)) {
    throw new UnsafePathError(`repo-dir ${JSON.stringify(repoDir)} is inside the dev-loop root; only the v2 clone dir may be (omit targetRepo.path to use it)`);
  }
  return repoDir;
}

export function buildSkillPrompt({ role, ticketKey, runDir, repoDir }: SkillPromptArgs): string {
  const skill = SKILL_NAME[role];
  if (skill === undefined) throw new UnsafePathError(`role ${JSON.stringify(role)} has no skill`);
  if (typeof ticketKey !== "string" || !TICKET_KEY.test(ticketKey)) {
    throw new UnsafePathError(`ticket key ${JSON.stringify(ticketKey)} must match ${TICKET_KEY}`);
  }
  checkAbsPath("run-dir", runDir);
  checkAbsPath("repo-dir", repoDir);
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
