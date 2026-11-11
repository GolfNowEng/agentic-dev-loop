/**
 * CLI entrypoint:
 *   `node --env-file=.env src/main.ts --phase research|dev --project <name> [--session <name>] [--once] [--stream]`
 * `--config <path>` also works as a fallback for an arbitrary path outside
 * the naming convention; passing both --project and --config is an error.
 * `--phase` is required until Task 15 adds worker mode (both roles).
 *
 * Both phases load the one v2 project config and the repo-root
 * `pipeline.loop.config.json`, acquire a worker session
 * (`.pipeline/v2/<slug>/sessions`, one live worker per project), and loop on
 * `runWorkerIteration` (src/worker/cycle.ts) restricted to one role:
 *   - research: claim + ticket-refine; a green ticket is left with a pending
 *     handoff for a dev-enabled worker (no label swap, no dev).
 *   - dev: completes pending handoffs, then polls the dev JQL and runs
 *     ticket-to-pr; plus the v1 merged-PR reconciliation pass (Task 14
 *     moves it onto the v2 log).
 * Each writes one v2 iteration record per ticket iteration to
 * `runs/v2/<slug>.jsonl`; an idle iteration writes nothing.
 *
 * Until Task 15 the skills still derive their own RUN_DIR as
 * `.pipeline/<SLUG>/runs/<KEY>-<RUN_ID>` relative to their cwd, so runSkill
 * reads the verdict the v1 way (snapshot/newest run dir), and the research
 * process still chdirs into `research-loop/` (its CLAUDE.md and the
 * `.claude` symlink live there). The cycle's v2 run dir is used for the
 * in-flight record, PhaseEntry.run_dir and `usage.json` (raw claude usage).
 * Every spawn gets `--max-budget-usd` from the cycle (Ruling 16) and a hard
 * kill at the role's `runTimeoutMin`.
 *
 * This file is deliberately the untested composition root -- every piece of
 * logic it uses already has vitest coverage against injected fakes; this is
 * the real-IO wiring those fakes stand in for.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  loadConfig,
  loadLoopConfig,
  requiredPlaceholderFree,
  roleView,
  repoSlugFromUrl,
  targetRepoAddDir,
  resolveProjectConfigPath,
} from "./core/config.ts";
import type { Config, LoopConfig, RoleLimits } from "./core/types.ts";
import { credentialsFromEnv, assigneeAccountIdFromEnv, RealJiraClient } from "./core/jira-client.ts";
import type { JiraCredentials } from "./core/jira-client.ts";
import {
  RealGitHubClient,
  realExecGh,
  realExecGhPrView,
  realExecGhFindMergedPr,
  realFindOpenPrUrl,
} from "./core/github-client.ts";
import { hasLandedRun } from "./core/runs-log.ts";
import { snapshotRunDirs, findNewestRunDir } from "./core/run-dirs.ts";
import { redactSensitive } from "./core/redact.ts";
import { decideNextAction, type PollResultKind } from "./core/poll-loop.ts";
import { PROJECT_SLUG, legacyRunsLog, legacyRunDirs, resolveRepoPath, v2RunsLog, v2SessionsDir } from "./core/paths.ts";
import { acquireSession, isProcessAlive, type InFlight, type Session } from "./core/session.ts";
import { findLandedPrUrlAcross } from "./core/iteration-log.ts";
import type { RunSkillFn, RunSkillResult } from "./core/run-skill.ts";
import { spawnClaudeRun, startProgressTail } from "./core/spawn-claude.ts";
import { runWorkerIteration, type WorkerDeps } from "./worker/cycle.ts";
import { reconcileMergedTickets } from "./roles/dev/reconcile.ts";
import { ALLOWED_TOOLS as DEV_ALLOWED_TOOLS } from "./roles/dev/tools.ts";
import { devEarlySkillResult } from "./roles/dev/spawn-result.ts";
import { ALLOWED_TOOLS as RESEARCH_ALLOWED_TOOLS } from "./roles/research/tools.ts";
import { researchEarlySkillResult } from "./roles/research/spawn-result.ts";
import {
  assertResearchRoot,
  researchClaudeMdExcludes,
  REFINE_SKILL_MD_PATH,
} from "./roles/research/startup.ts";
import pkg from "../package.json" with { type: "json" };

type Phase = "research" | "dev";

const MODEL = "sonnet";
const SKILL_NAME: Record<Phase, string> = { research: "ticket-refine", dev: "ticket-to-pr" };
const DEV_SKILL_MD_PATH = ".claude/skills/ticket-to-pr/SKILL.md";
const LOOP_VERSION: string = pkg.version;

/**
 * Each phase's v1 root, relative to the repo root: the process chdirs here
 * before anything else, so every relative path below (config, runs/,
 * .pipeline/) and the spawned claude's cwd match that role's v1 checkout.
 */
const PHASE_ROOT: Record<Phase, string> = { research: "research-loop", dev: "." };


/**
 * Reads a flag's value in either `--name value` (space-separated) or
 * `--name=value` (equals-separated) form -- the latter lets a value-taking
 * flag sit next to a boolean one (`--stream --project=webtarsthree`)
 * without the space-separated form's visual ambiguity about which token
 * belongs to which flag.
 */
function getArgValue(argv: string[], name: string): string | undefined {
  const eqPrefix = `${name}=`;
  const eqArg = argv.find((arg) => arg.startsWith(eqPrefix));
  if (eqArg !== undefined) return eqArg.slice(eqPrefix.length);
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : undefined;
}

function parseArgs(argv: string[]): {
  phase: Phase;
  project?: string;
  configPath?: string;
  session?: string;
  once: boolean;
  stream: boolean;
} {
  const phase = getArgValue(argv, "--phase");
  if (phase !== "research" && phase !== "dev") {
    throw new Error(
      `main.ts requires --phase research|dev${phase === undefined ? "" : ` (got "${phase}")`}.`,
    );
  }
  const project = getArgValue(argv, "--project");
  const configPath = getArgValue(argv, "--config");
  if (project && configPath) {
    throw new Error("main.ts: pass either --project <name> or --config <path>, not both.");
  }
  if (!project && !configPath) {
    throw new Error(
      "main.ts requires --project <name> (or --config <path-to-pipeline.<project>.config.json> as a fallback).",
    );
  }
  return {
    phase,
    project,
    configPath,
    session: getArgValue(argv, "--session"),
    once: argv.includes("--once"),
    stream: argv.includes("--stream"),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redacting wrappers around console.log/console.error -- every line this
 * process prints goes through redactSensitive() first, so an email address
 * (and, on machines where $HOME is email-shaped, any absolute path
 * containing it) or a secret-shaped value never reaches the terminal or a
 * captured log, regardless of whether it came from our own message or
 * from something a spawned `claude` process/subagent tool call printed.
 */
function log(message: string): void {
  console.log(redactSensitive(message));
}

function logError(message: string): void {
  console.error(redactSensitive(message));
}

function gitFileSha(relativePath: string): string {
  return execFileSync("git", ["log", "-1", "--format=%H", "--", relativePath], {
    encoding: "utf8",
  }).trim();
}

/** Prints claude's own result text and permission denials when a run left no usable verdict. */
function logNoVerdictDiagnostics(skill: string, ticketKey: string, stdout: string): void {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: string;
      permission_denials?: Array<{ tool_name: string }>;
    } | null;
    if (parsed?.result) {
      logError(`[${skill}] ${ticketKey}: claude's own result text: ${parsed.result}`);
    }
    if (parsed?.permission_denials?.length) {
      const denied = parsed.permission_denials.map((d) => d.tool_name).join(", ");
      logError(`[${skill}] ${ticketKey}: permission denials: ${denied}`);
    }
  } catch {
    // Diagnostic logging must never itself crash the loop.
  }
}

/** The env both phases spawn claude with (childEnv() in spawn-claude strips the JIRA_* creds). */
function claudeEnvFor(limits: RoleLimits): NodeJS.ProcessEnv {
  // Align the CLI's own internal background-task wait ceiling with this
  // project's own runTimeoutMin ceiling, computed from config so the two
  // can never drift out of sync -- without this, a subagent that
  // legitimately runs long gets its whole headless session killed at the
  // CLI's 600s default, well before this project's own timeout would have
  // caught it.
  return {
    ...process.env,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(limits.runTimeoutMin * 60_000),
  };
}

// ---------------------------------------------------------------------------

interface PhaseContext {
  phase: Phase;
  config: Config;
  loopConfig: LoopConfig;
  once: boolean;
  stream: boolean;
  credentials: JiraCredentials;
  jiraClient: RealJiraClient;
  githubClient: RealGitHubClient;
  slug: string;
  /** v1 run-dir root the skill still writes to (cwd-relative), for verdict discovery. */
  runsBaseDir: string;
  /** CLAUDE.md files the spawned claude must not load (research: dev's root CLAUDE.md). */
  excludeClaudeMd: string[];
}

/** Research only: find or create the ticket's mirror GitHub Issue before the run. Never throws. */
async function ensureMirrorIssue(ctx: PhaseContext, ticketKey: string): Promise<void> {
  const skill = SKILL_NAME.research;
  try {
    const existing = await ctx.githubClient.findIssueByJiraKey(ticketKey);
    if (existing) {
      log(`[${skill}] ${ticketKey}: GitHub Issue already exists (${existing.url}), skipping creation`);
      return;
    }
    const issue = await ctx.githubClient.createIssue({
      title: `${ticketKey}: (refinement in progress)`,
      body: `Mirror of [${ticketKey}](${ctx.credentials.baseUrl}/browse/${ticketKey}). ticket-refine is running -- this Issue will be updated with recon/attack/verify findings per the routing rule as the run progresses.`,
      jiraKey: ticketKey,
    });
    log(`[${skill}] ${ticketKey}: created GitHub Issue ${issue.url}`);
  } catch (err) {
    // Never blocks the ticket-refine run; a later run retries.
    logError(`[${skill}] ${ticketKey}: GitHub Issue creation/lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The real RunSkillFn: one `claude -p` spawn, verdict read the v1 way (Ruling 17). Never throws for a run failure. */
function makeRunSkill(ctx: PhaseContext): RunSkillFn {
  const skillVersion: Record<Phase, string> = {
    research: ctx.phase === "research" ? gitFileSha(REFINE_SKILL_MD_PATH) : "",
    dev: ctx.phase === "dev" ? gitFileSha(DEV_SKILL_MD_PATH) : "",
  };
  return async ({ role, ticketKey, runDir, maxBudgetUsd }): Promise<RunSkillResult> => {
    const skill = SKILL_NAME[role];
    const view = roleView(ctx.config, role);
    if (role === "research") await ensureMirrorIssue(ctx, ticketKey);

    const before = await snapshotRunDirs(ctx.runsBaseDir, ticketKey);
    log(`[${skill}] ${ticketKey}: running (run dir ${runDir}, budget $${maxBudgetUsd})...`);
    const tail = startProgressTail(ctx.runsBaseDir, ticketKey, before, skill, log);
    const run = await spawnClaudeRun(
      {
        prompt: `/${skill} ${ticketKey}`,
        model: MODEL,
        allowedTools: role === "research" ? RESEARCH_ALLOWED_TOOLS : DEV_ALLOWED_TOOLS,
        // ticket-to-pr's worktrees live inside targetRepo.path: without
        // --add-dir every Edit/Write there is denied (TARS-1393).
        addDir: role === "dev" ? targetRepoAddDir(ctx.config) : null,
        excludeClaudeMd: role === "research" ? ctx.excludeClaudeMd : [],
        timeoutMin: view.limits.runTimeoutMin,
        maxBudgetUsd,
        stream: ctx.stream,
        ticketKey,
        rawUsagePath: join(resolveRepoPath(runDir), "usage.json"),
        env: claudeEnvFor(view.limits),
      },
      { logPrefix: skill, log, logError },
    );
    await tail.stop();

    const base = { skillVersion: skillVersion[role], model: MODEL };
    const early =
      role === "research"
        ? researchEarlySkillResult(run, base, view.limits.runTimeoutMin)
        : devEarlySkillResult(run, base, view.limits.runTimeoutMin);
    if (early) return early;

    const runDirName = await findNewestRunDir(ctx.runsBaseDir, ticketKey, before);
    let verdictRaw: string | undefined;
    if (runDirName) {
      try {
        // Redacted before it leaves here: the skill's self-report lands in the record's detail.
        verdictRaw = redactSensitive(await readFile(join(ctx.runsBaseDir, runDirName, "verdict.json"), "utf8"));
      } catch {
        verdictRaw = undefined;
      }
    }
    if (verdictRaw === undefined) logNoVerdictDiagnostics(skill, ticketKey, run.stdout);
    return { ...base, verdictRaw, started: run.started, ended: run.ended, costUsd: run.usage.costUsd, tokens: run.usage.tokens };
  };
}

/** Dev only: the v1 merged-PR reconciliation pass (reads the v1 dev log until Task 14). Never throws. */
async function reconcile(ctx: PhaseContext, execGhPrView: ReturnType<typeof realExecGhPrView>, reconciled: Set<string>): Promise<void> {
  const skill = SKILL_NAME.dev;
  try {
    const r = await reconcileMergedTickets({
      jiraClient: ctx.jiraClient,
      githubClient: ctx.githubClient,
      view: roleView(ctx.config, "dev"),
      runsLogPath: legacyRunsLog(ctx.slug),
      execGhPrView,
      execGhFindMergedPr: realExecGhFindMergedPr(ctx.config.github.repo),
      reconciled,
    });
    if (r.closed.length > 0) log(`[${skill}] reconciliation: merged PR(s) reconciled for ${r.closed.join(", ")}`);
    for (const err of r.errors) logError(`[${skill}] reconciliation: ${err.ticket}: ${err.message}`);
  } catch (err) {
    logError(`[${skill}] reconciliation pass failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runPhaseLoop(ctx: PhaseContext, session: Session, assigneeAccountId: string): Promise<void> {
  const prefix = SKILL_NAME[ctx.phase];
  const { config, loopConfig, once } = ctx;
  const projectSlug = v2Slug(ctx.slug);
  const execGhPrView = realExecGhPrView();
  const deps: WorkerDeps = {
    jira: ctx.jiraClient,
    github: ctx.githubClient,
    config,
    slug: projectSlug,
    session,
    loopVersion: LOOP_VERSION,
    runSkill: makeRunSkill(ctx),
    logPath: resolveRepoPath(v2RunsLog(projectSlug)),
    now: () => new Date(),
    assigneeAccountId,
    gate: {
      findLandedPrUrl: (key) => findLandedPrUrlAcross(projectSlug, key),
      execGhPrView,
      execGhFindMergedPr: realExecGhFindMergedPr(config.github.repo),
      mergedCache: new Map(),
    },
    findOpenPrUrl: realFindOpenPrUrl(config.github.repo),
    roles: [ctx.phase],
    // Never re-refine a ticket the v1 research runner already refined.
    hasLandedResearchV1: ctx.phase === "research" ? (key) => hasLandedRun(legacyRunsLog(ctx.slug), key) : undefined,
    log,
  };

  log(`[${prefix}] session ${session.name}: loop started, polling every ${loopConfig.pollIntervalSec}s (project: ${ctx.slug})`);
  const reconciled = new Set<string>();
  for (;;) {
    if (ctx.phase === "dev") await reconcile(ctx, execGhPrView, reconciled);
    const result = await runWorkerIteration(deps);
    let kind: PollResultKind;
    switch (result.kind) {
      case "idle":
        log(`[${prefix}] nothing to do, sleeping ${loopConfig.pollIntervalSec}s`);
        kind = "idle";
        break;
      case "did":
        log(`[${prefix}] ${result.record.ticket}: ${result.record.outcome}${result.record.detail ? ` (${result.record.detail})` : ""}`);
        if (result.record.jira_sync_error) {
          logError(`[${prefix}] ${result.record.ticket}: WARNING -- a Jira/GitHub write failed (${result.record.jira_sync_error}); the record is logged, check the ticket by hand.`);
        }
        kind = "ran";
        break;
      case "paused":
        logError(`[${prefix}] PAUSED: ${result.reason}`);
        await session.release();
        process.exit(1);
    }
    const action = decideNextAction(kind, loopConfig, once);
    if (action.kind === "exit") return;
    if (action.kind === "sleep") await sleep(action.ms);
  }
}

/** v1 slugs (repoSlugFromUrl) may have characters v2 paths reject; v2 paths need PROJECT_SLUG. */
function v2Slug(slug: string): string {
  if (!PROJECT_SLUG.test(slug)) {
    throw new Error(`project slug ${JSON.stringify(slug)} (from targetRepo.url) must match ${PROJECT_SLUG} for the v2 log and run dirs`);
  }
  return slug;
}

// ---------------------------------------------------------------------------

let activePhase: Phase | null = null;

async function main(): Promise<void> {
  const { phase, project, configPath, session: requestedSession, once, stream } = parseArgs(process.argv.slice(2));
  activePhase = phase;

  // Resolve and load everything repo-root-relative before the research
  // phase chdirs into its v1 root (--config is relative to the caller's cwd).
  const repoRoot = process.cwd();
  const resolvedConfigPath = resolve(configPath ?? (await resolveProjectConfigPath(project)));
  const config = await loadConfig(resolvedConfigPath);
  requiredPlaceholderFree(config, phase);
  const loopConfig = await loadLoopConfig(resolve("pipeline.loop.config.json"));
  // Fail loudly, before any Jira/GitHub I/O, if the research root no longer
  // has the skill claude -p needs (e.g. .claude/ moved but PHASE_ROOT didn't).
  if (phase === "research") assertResearchRoot(PHASE_ROOT.research);
  // v1 research ran from its own repo and loaded only research-loop/CLAUDE.md;
  // here the parent dev CLAUDE.md would load too, so exclude it.
  const excludeClaudeMd =
    phase === "research" ? researchClaudeMdExcludes(repoRoot, PHASE_ROOT.research) : [];

  const credentials = credentialsFromEnv();
  const assigneeAccountId = assigneeAccountIdFromEnv();
  const jiraClient = new RealJiraClient(credentials, config);
  const githubClient = new RealGitHubClient(config.github, realExecGh());
  const slug = repoSlugFromUrl(config.targetRepo.url);

  // One live worker per project. v2 paths are absolute (resolveRepoPath), so
  // the chdir below doesn't move them.
  const session = await acquireSession({
    dir: resolveRepoPath(v2SessionsDir(v2Slug(slug))),
    requested: requestedSession,
    pid: process.pid,
    isAlive: isProcessAlive,
    now: new Date(),
  });
  const tracked = trackInFlight(session);
  const onSignal = (sig: NodeJS.Signals) => {
    // Mid-phase, keep the lock (and its inFlight) for the next start to
    // resume: a dead pid's lock is reclaimed. Otherwise release it.
    void (tracked.busy() ? Promise.resolve() : session.release()).finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  log(`[${SKILL_NAME[phase]}] acquired session ${session.name}`);

  process.chdir(PHASE_ROOT[phase]);
  const ctx: PhaseContext = {
    phase,
    config,
    loopConfig,
    once,
    stream,
    credentials,
    jiraClient,
    githubClient,
    slug,
    runsBaseDir: legacyRunDirs(slug),
    excludeClaudeMd,
  };
  try {
    await runPhaseLoop(ctx, tracked.session, assigneeAccountId);
  } finally {
    if (!tracked.busy()) await session.release();
  }
}

/** Wraps setInFlight so main knows whether a phase is mid-run (keep the lock on a signal). */
function trackInFlight(session: Session): { session: Session; busy: () => boolean } {
  let current: InFlight | null = session.inFlight;
  return {
    session: {
      ...session,
      setInFlight: async (f) => {
        await session.setInFlight(f);
        current = f;
      },
    },
    busy: () => current !== null,
  };
}

main().catch((err) => {
  const prefix = activePhase ? SKILL_NAME[activePhase] : "main";
  logError(`[${prefix}] fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
