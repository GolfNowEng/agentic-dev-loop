/**
 * CLI entrypoint:
 *   `node --env-file=.env src/main.ts --project <name> [--phase worker|research|dev] [--session <name>] [--once] [--stream]`
 * `--config <path>` also works as a fallback for an arbitrary path outside
 * the naming convention; passing both --project and --config is an error
 * (src/core/cli-args.ts parses and tests all of it).
 *
 * `--phase worker` (the default) runs both roles on one session:
 * `runWorkerIteration` claims a ticket, runs ticket-refine, hands it off and
 * runs ticket-to-pr on it, plus the merged-PR reconciliation pass.
 * `--phase research|dev` run the same cycle restricted to one role (kept
 * for regression).
 *
 * Startup order: resolve the config path -> loadConfig -> preflight
 * (requiredPlaceholderFree(phase), then in worker mode the label-version
 * guard: a v1-labelled project such as catalog-ui-* exits 1, a minor/patch
 * difference is a warning) -> credentials -> acquireSession (one live worker
 * per project; a second start names the live session and exits 1) ->
 * record the adopted in-flight runs -> loop. REPO_DIR must be absolute and
 * normalized, and may not be the dev-loop root, an ancestor of it, or inside
 * it (except the v2 clone dir). SIGINT/SIGTERM first stop the running
 * `claude -p` child (SIGTERM, then SIGKILL after KILL_GRACE_MS), then
 * release the lock unless a phase is mid-run (then its flight is marked
 * interrupted).
 *
 * Every spawn runs from the repo root and gets
 * `/<skill> <KEY> run-dir=<abs RUN_DIR> repo-dir=<abs REPO_DIR>`
 * (src/worker/skill-runner.ts); the verdict is read from RUN_DIR/verdict.json
 * only. Research excludes the root CLAUDE.md and appends
 * src/roles/research/stance.md as its system prompt.
 *
 * This file is deliberately the untested composition root -- every piece of
 * logic it uses already has vitest coverage against injected fakes; this is
 * the real-IO wiring those fakes stand in for.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig, loadLoopConfig, repoSlugFromUrl, resolveProjectConfigPath } from "./core/config.ts";
import type { Config, LoopConfig, Role } from "./core/types.ts";
import { credentialsFromEnv, assigneeAccountIdFromEnv, RealJiraClient } from "./core/jira-client.ts";
import type { JiraCredentials } from "./core/jira-client.ts";
import {
  RealGitHubClient,
  realExecGh,
  realExecGhPrView,
  realExecGhFindMergedPr,
  realFindOpenPrUrl,
} from "./core/github-client.ts";
import { redactSensitive } from "./core/redact.ts";
import { decideNextAction, type PollResultKind } from "./core/poll-loop.ts";
import { PROJECT_SLUG, resolveRepoPath, v2CloneDir, v2RunsLog, v2SessionsDir } from "./core/paths.ts";
import { acquireSession, isProcessAlive, LiveWorkerError } from "./core/session.ts";
import { stopOnSignal, trackSession, type TrackedSession } from "./worker/signal.ts";
import { findLandedPrUrlAcross, hasLandedV1 } from "./core/iteration-log.ts";
import { parseArgs, preflight, type Phase } from "./core/cli-args.ts";
import { checkAbsPath, checkRepoDirPlacement, repoDirFor, SKILL_NAME } from "./core/build-prompt.ts";
import { killActiveChild, spawnClaudeRun } from "./core/spawn-claude.ts";
import { recordAdoptedFlights, runWorkerIteration, type WorkerDeps } from "./worker/cycle.ts";
import { makeRunSkill } from "./worker/skill-runner.ts";
import { reconcileMergedTickets } from "./roles/dev/reconcile.ts";
import { loadResearchStance, REFINE_SKILL_MD_PATH } from "./roles/research/startup.ts";
import pkg from "../package.json" with { type: "json" };

const DEV_SKILL_MD_PATH = ".claude/skills/ticket-to-pr/SKILL.md";
const LOOP_VERSION: string = pkg.version;
/** The repo root: both roles spawn here, and every relative path resolves against it. */
const REPO_ROOT = resolve(import.meta.dirname, "..");

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
    cwd: REPO_ROOT,
  }).trim();
}

const rolesOf = (phase: Phase): Role[] => (phase === "worker" ? ["research", "dev"] : [phase]);
const prefixOf = (phase: Phase): string => (phase === "worker" ? "worker" : SKILL_NAME[phase]);

// ---------------------------------------------------------------------------

interface LoopContext {
  phase: Phase;
  roles: Role[];
  config: Config;
  loopConfig: LoopConfig;
  once: boolean;
  stream: boolean;
  credentials: JiraCredentials;
  jiraClient: RealJiraClient;
  githubClient: RealGitHubClient;
  slug: string;
  researchStance: string;
}

/** Research only: find or create the ticket's mirror GitHub Issue before the run. Never throws. */
async function ensureMirrorIssue(ctx: LoopContext, ticketKey: string): Promise<void> {
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

/** Dev only: the merged-PR reconciliation pass over the v1 and v2 landed logs. Never throws. */
async function reconcile(
  ctx: LoopContext,
  session: string,
  execGhPrView: ReturnType<typeof realExecGhPrView>,
  reconciled: Set<string>,
): Promise<void> {
  const skill = SKILL_NAME.dev;
  try {
    const r = await reconcileMergedTickets({
      jiraClient: ctx.jiraClient,
      githubClient: ctx.githubClient,
      config: ctx.config,
      slug: ctx.slug,
      session,
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

async function runLoop(ctx: LoopContext, tracked: TrackedSession, assigneeAccountId: string): Promise<void> {
  const session = tracked.session;
  const prefix = prefixOf(ctx.phase);
  const { config, loopConfig, once, slug } = ctx;
  const execGhPrView = realExecGhPrView();
  const runsResearch = ctx.roles.includes("research");
  const runsDev = ctx.roles.includes("dev");
  const deps: WorkerDeps = {
    jira: ctx.jiraClient,
    github: ctx.githubClient,
    config,
    slug,
    session,
    loopVersion: LOOP_VERSION,
    runSkill: makeRunSkill({
      config,
      slug,
      repoRoot: REPO_ROOT,
      stream: ctx.stream,
      researchStance: ctx.researchStance,
      skillVersion: {
        research: runsResearch ? gitFileSha(REFINE_SKILL_MD_PATH) : "",
        dev: runsDev ? gitFileSha(DEV_SKILL_MD_PATH) : "",
      },
      spawn: (opts) => spawnClaudeRun(opts, { log, logError }),
      beforeRun: (_role, key) => ensureMirrorIssue(ctx, key),
      log,
      logError,
    }),
    logPath: resolveRepoPath(v2RunsLog(slug)),
    now: () => new Date(),
    assigneeAccountId,
    gate: {
      findLandedPrUrl: (key) => findLandedPrUrlAcross(slug, key),
      execGhPrView,
      execGhFindMergedPr: realExecGhFindMergedPr(config.github.repo),
      mergedCache: new Map(),
    },
    findOpenPrUrl: realFindOpenPrUrl(config.github.repo),
    roles: ctx.roles,
    // Never re-refine a ticket the v1 research runner already refined.
    hasLandedResearchV1: runsResearch ? (key) => hasLandedV1("research", slug, key) : undefined,
    log,
  };

  // First, before any network-bound work: the adopted in-flight runs go to the log.
  await recordAdoptedFlights(deps);
  tracked.markFlightsRecorded();

  log(`[${prefix}] session ${session.name}: loop started (roles: ${ctx.roles.join(", ")}), polling every ${loopConfig.pollIntervalSec}s (project: ${slug})`);
  const reconciled = new Set<string>();
  for (;;) {
    if (runsDev) await reconcile(ctx, session.name, execGhPrView, reconciled);
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
        // A signal is being handled: stopOnSignal owns the lock and the exit code (130/143).
        if (tracked.isStopping()) await new Promise<never>(() => {});
        if (tracked.canRelease()) await session.release();
        process.exit(1);
    }
    const action = decideNextAction(kind, loopConfig, once);
    if (action.kind === "exit") return;
    if (action.kind === "sleep") await sleep(action.ms);
  }
}

// ---------------------------------------------------------------------------

let activePhase: Phase | null = null;

async function main(): Promise<void> {
  const { phase, project, configPath, session: requestedSession, once, stream } = parseArgs(process.argv.slice(2));
  activePhase = phase;
  const prefix = prefixOf(phase);
  const roles = rolesOf(phase);

  // --config is relative to the caller's cwd; --project looks in the repo root.
  const resolvedConfigPath = configPath ? resolve(configPath) : await resolveProjectConfigPath(project, REPO_ROOT);
  const config = await loadConfig(resolvedConfigPath);
  for (const warning of preflight(config, phase, LOOP_VERSION).warnings) logError(`[${prefix}] WARNING: ${warning}`);
  const loopConfig = await loadLoopConfig(resolve(REPO_ROOT, "pipeline.loop.config.json"));
  const slug = repoSlugFromUrl(config.targetRepo.url);
  if (!PROJECT_SLUG.test(slug)) {
    throw new Error(`project slug ${JSON.stringify(slug)} (from targetRepo.url) must match ${PROJECT_SLUG} for the v2 log and run dirs`);
  }
  // Fail before any I/O if the research stance is missing (it replaces the excluded root CLAUDE.md).
  const researchStance = roles.includes("research") ? await loadResearchStance(REPO_ROOT) : "";
  // REPO_DIR goes into every prompt: a malformed targetRepo.path exits 1 here, before the lock.
  checkAbsPath("repo-dir", repoDirFor(config, slug));
  checkRepoDirPlacement(repoDirFor(config, slug), REPO_ROOT, resolveRepoPath(v2CloneDir(slug)));

  const credentials = credentialsFromEnv();
  const assigneeAccountId = assigneeAccountIdFromEnv();
  const jiraClient = new RealJiraClient(credentials, config);
  const githubClient = new RealGitHubClient(config.github, realExecGh());

  // One live worker per project. Test seams (_hooks) are never passed here.
  let session;
  try {
    session = await acquireSession({
      dir: resolveRepoPath(v2SessionsDir(slug)),
      requested: requestedSession,
      pid: process.pid,
      isAlive: isProcessAlive,
      now: new Date(),
    });
  } catch (err) {
    if (err instanceof LiveWorkerError) {
      logError(`[${prefix}] refusing to start: ${err.message}. Stop session "${err.liveSession}" first.`);
      process.exit(1);
    }
    throw err;
  }
  const tracked = trackSession(session, logError);
  const onSignal = (sig: NodeJS.Signals) => {
    // Stop the running claude -p child first (SIGTERM, SIGKILL after
    // KILL_GRACE_MS), so it cannot keep running orphaned. Then, mid-phase:
    // keep the lock, its inFlight marked interrupted (the next start resumes
    // it without counting an attempt). Otherwise release the lock.
    void stopOnSignal(sig, { tracked, killChild: () => killActiveChild(), exit: (code) => process.exit(code), logError });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  log(`[${prefix}] acquired session ${session.name}`);

  const ctx: LoopContext = {
    phase,
    roles,
    config,
    loopConfig,
    once,
    stream,
    credentials,
    jiraClient,
    githubClient,
    slug,
    researchStance,
  };
  try {
    await runLoop(ctx, tracked, assigneeAccountId);
  } finally {
    // Never release while an adopted flight is only in the lock, or a phase is mid-run.
    if (tracked.canRelease()) await session.release();
  }
  log(`[${prefix}] session ${session.name}: released, exiting`);
}

main().catch((err) => {
  const prefix = activePhase ? prefixOf(activePhase) : "main";
  logError(`[${prefix}] fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
