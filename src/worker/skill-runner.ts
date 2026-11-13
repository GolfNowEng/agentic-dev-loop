// The real RunSkillFn: one `claude -p` per phase run, over an injected spawn
// so it is tested without a real claude.
//
//   1. Build the prompt from validated values only (build-prompt.ts):
//      `/<skill> <KEY> run-dir=<abs RUN_DIR> repo-dir=<abs REPO_DIR>`.
//   2. Create RUN_DIR.
//   3. Spawn from the repo root, both roles. Research excludes the root
//      CLAUDE.md and appends its stance (roles/research/startup.ts).
//   4. Read RUN_DIR/verdict.json -- the only place a verdict is read.
//      Except: an enforcing sandbox that refused something parks the run
//      first, and verdict.json is never read.
//
// Never throws for a run failure (spawn error, timeout kill, no verdict);
// it throws only for a runDir/key that fails validation, before spawning,
// which the phase runner records as agent_error.

import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { roleView, targetRepoAddDir } from "../core/config.ts";
import type { Config, Role } from "../core/types.ts";
import { resolveRepoPath } from "../core/paths.ts";
import { buildSkillPrompt, checkAbsPath, claudeEnvFor, repoDirFor, SKILL_NAME } from "../core/build-prompt.ts";
import { redactSensitive } from "../core/redact.ts";
import type { RunSkillFn, RunSkillResult } from "../core/run-skill.ts";
import { startProgressTail, type SpawnClaudeOpts, type SpawnClaudeResult } from "../core/spawn-claude.ts";
import { ALLOWED_TOOLS as DEV_ALLOWED_TOOLS } from "../roles/dev/tools.ts";
import { devEarlySkillResult } from "../roles/dev/spawn-result.ts";
import { ALLOWED_TOOLS as RESEARCH_ALLOWED_TOOLS } from "../roles/research/tools.ts";
import { researchEarlySkillResult } from "../roles/research/spawn-result.ts";
import { researchClaudeMdExcludes } from "../roles/research/startup.ts";
import type { SandboxSelection } from "../sandbox/select.ts";

export const MODEL = "sonnet";

export interface SkillRunnerDeps {
  config: Config;
  /** Project slug (PROJECT_SLUG). */
  slug: string;
  /** Absolute repo root: the spawn cwd for both roles. */
  repoRoot: string;
  stream: boolean;
  /** The research stance text (loadResearchStance), appended to the research spawn's system prompt. */
  researchStance: string;
  /** Git SHA of each role's SKILL.md ("" for a role this process does not run). */
  skillVersion: Record<Role, string>;
  /** spawnClaudeRun in production. */
  spawn: (opts: SpawnClaudeOpts) => Promise<SpawnClaudeResult>;
  /** Research: find or create the mirror GitHub Issue before the run. Must not throw. */
  beforeRun?: (role: Role, ticketKey: string) => Promise<void>;
  log: (message: string) => void;
  logError: (message: string) => void;
  /** Run every spawn through this sandbox. Absent: spawn opts get no `sandbox` key at all. */
  sandbox?: SandboxSelection;
  /** 6 lowercase hex chars for the instance name; randomBytes(3) by default. */
  shortId?: () => string;
}

/** Lowercase, and any char outside [a-z0-9-] becomes "-". */
function sandboxNamePart(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * `dl-<len>-<project>-`: every instance name of this project starts with it,
 * and main.ts passes it as the `cleanupOrphans` scope, so one project's
 * startup never removes another project's sandboxes. The length makes the
 * prefixes prefix-free: without it, `dl-a-` would also match `dl-a-b-...`.
 */
export function sandboxInstancePrefix(project: string): string {
  const part = sandboxNamePart(project);
  return `dl-${part.length}-${part}-`;
}

/** Docker-style name limit. */
const MAX_INSTANCE_NAME = 63;

/** `dl-<len>-<project>-<ticket lowercased>-<role>-<shortId>`, sanitized to [a-z0-9-], e.g. dl-12-webtarsthree-tars-1-dev-a1b2c3. */
export function sandboxInstanceName(project: string, ticketKey: string, role: Role, shortId: string): string {
  const prefix = sandboxInstancePrefix(project);
  const tail = sandboxNamePart(`-${shortId}`);
  const middle = sandboxNamePart(`${ticketKey}-${role}`);
  const room = Math.max(0, MAX_INSTANCE_NAME - prefix.length - tail.length);
  // Over the cap: trim only the ticket-role middle, then drop a dangling "-".
  const kept = middle.length > room ? middle.slice(0, room).replace(/-+$/, "") : middle;
  return kept ? `${prefix}${kept}${tail}` : `${prefix}${tail.slice(1)}`;
}

/**
 * [repoRoot, repoDir], deduplicated, with repoDir dropped when it is inside
 * repoRoot (the v2 clone). The per-run worktree is created inside repoDir,
 * so mounting repoDir covers it.
 */
export function sandboxMounts(repoRoot: string, repoDir: string): string[] {
  const rel = relative(repoRoot, repoDir);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return inside ? [repoRoot] : [repoRoot, repoDir];
}

/** Prints claude's own result text and permission denials when a run left no usable verdict. */
function logNoVerdictDiagnostics(logError: (m: string) => void, skill: string, ticketKey: string, stdout: string): void {
  try {
    const parsed = JSON.parse(stdout) as { result?: string; permission_denials?: Array<{ tool_name: string }> } | null;
    if (parsed?.result) logError(`[${skill}] ${ticketKey}: claude's own result text: ${parsed.result}`);
    if (parsed?.permission_denials?.length) {
      logError(`[${skill}] ${ticketKey}: permission denials: ${parsed.permission_denials.map((d) => d.tool_name).join(", ")}`);
    }
  } catch {
    // Diagnostic logging must never itself crash the loop.
  }
}

export function makeRunSkill(deps: SkillRunnerDeps): RunSkillFn {
  // Validated here, at startup (main.ts builds this before the loop), so a
  // malformed targetRepo.path exits 1 instead of failing every ticket.
  const repoDir = checkAbsPath("repo-dir", repoDirFor(deps.config, deps.slug));
  // --add-dir: a targetRepo.path checkout sits outside the repo root, so
  // without it every Edit/Write in the worktree is denied (TARS-1393). The
  // v2 clone is under the repo root already.
  const addDir = targetRepoAddDir(deps.config);
  const mounts = sandboxMounts(deps.repoRoot, repoDir);
  const shortId = deps.shortId ?? (() => randomBytes(3).toString("hex"));

  return async ({ role, ticketKey, runDir, maxBudgetUsd }): Promise<RunSkillResult> => {
    const skill = SKILL_NAME[role];
    const view = roleView(deps.config, role);
    const absRunDir = resolveRepoPath(runDir);
    const prompt = buildSkillPrompt({ role, ticketKey, runDir: absRunDir, repoDir });

    if (deps.beforeRun && role === "research") await deps.beforeRun(role, ticketKey);
    await mkdir(absRunDir, { recursive: true });

    const sandbox = deps.sandbox
      ? { adapter: deps.sandbox.adapter, run: { instanceName: sandboxInstanceName(deps.slug, ticketKey, role, shortId()), mounts, config: deps.sandbox.config } }
      : undefined;
    const where = sandbox ? ` in ${sandbox.run.instanceName}` : "";
    deps.log(`[${skill}] ${ticketKey}: running${where} (run dir ${runDir}, budget $${maxBudgetUsd})...`);
    const tail = startProgressTail(absRunDir, ticketKey, skill, deps.log);
    let run: SpawnClaudeResult;
    try {
      run = await deps.spawn({
        prompt,
        model: MODEL,
        allowedTools: role === "research" ? RESEARCH_ALLOWED_TOOLS : DEV_ALLOWED_TOOLS,
        addDir,
        cwd: deps.repoRoot,
        excludeClaudeMd: role === "research" ? researchClaudeMdExcludes(deps.repoRoot) : [],
        // Research must not write the target checkout (Ruling 27). --allowedTools
        // only auto-approves; acceptEdits + --add-dir would otherwise make
        // REPO_DIR writable. RUN_DIR (under the repo root) stays writable for
        // draft-spec.md/verdict.json. This is only partly read-only: research
        // still has broad Bash, which this deny does not cover.
        denyEditsUnder: role === "research" ? [repoDir] : [],
        logPrefix: skill,
        ...(role === "research" ? { appendSystemPrompt: deps.researchStance } : {}),
        timeoutMin: view.limits.runTimeoutMin,
        maxBudgetUsd,
        stream: deps.stream,
        ticketKey,
        rawUsagePath: join(absRunDir, "usage.json"),
        env: claudeEnvFor(view.limits, process.env),
        ...(sandbox ? { sandbox } : {}),
      });
    } finally {
      await tail.stop();
    }

    const base = { skillVersion: deps.skillVersion[role], model: MODEL };
    // Before the early results: a prepare failure also sets spawnError, and it must park, not error.
    const denied = run.sandbox?.report.denied ?? [];
    if (deps.sandbox && denied.length > 0) {
      const refused = denied.map((d) => `${d.kind} ${d.target}`).join(", ");
      if (deps.sandbox.mode === "enforce") {
        deps.log(redactSensitive(`[${skill}] ${ticketKey}: sandbox refused ${refused}; parking`));
        const approveHint = run.sandbox!.report.approveHint;
        return {
          ...base,
          verdictRaw: undefined,
          parked: { denied, ...(approveHint !== undefined ? { approveHint } : {}) },
          started: run.started,
          ended: run.ended,
          costUsd: run.usage.costUsd,
          tokens: run.usage.tokens,
        };
      }
      deps.log(redactSensitive(`[${skill}] ${ticketKey}: sandbox refused ${refused}; discover mode, not parking`));
    }
    const early =
      role === "research"
        ? researchEarlySkillResult(run, base, view.limits.runTimeoutMin)
        : devEarlySkillResult(run, base, view.limits.runTimeoutMin);
    if (early) return early;

    let verdictRaw: string | undefined;
    try {
      // Redacted before it leaves here: the skill's self-report lands in the record's detail.
      verdictRaw = redactSensitive(await readFile(join(absRunDir, "verdict.json"), "utf8"));
    } catch {
      verdictRaw = undefined;
    }
    if (verdictRaw === undefined) logNoVerdictDiagnostics(deps.logError, skill, ticketKey, run.stdout);
    return { ...base, verdictRaw, started: run.started, ended: run.ended, costUsd: run.usage.costUsd, tokens: run.usage.tokens };
  };
}
