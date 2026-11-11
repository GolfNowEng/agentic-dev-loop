/**
 * CLI entrypoint:
 *   `node --env-file=.env src/main.ts --phase research|dev --project <name> [--once] [--stream]`
 * `--config <path>` also works as a fallback for an arbitrary path outside
 * the naming convention; passing both --project and --config is an error.
 * `--phase` is required (Task 4 of the 2.0.0 migration).
 *
 * Each phase runs its role's **v1** runner exactly as its old main.ts did,
 * from its v1 root, against its own v1 config file, writing v1-shaped logs
 * to the v1 paths (`runs/<slug>.jsonl`, `.pipeline/<slug>/{runs,raw-usage}`
 * under that root):
 *   - research: research-loop's runner (src/roles/research/phase.ts), with
 *     its mirror-Issue creation. The process chdirs into `research-loop/`
 *     first, which is where v1 research-loop ran: its config files, its
 *     runs/ and .pipeline/, and its `.claude/` (the ticket-refine skill and
 *     its hooks, which `claude -p` finds from its cwd) all live there until
 *     Tasks 5/8/9 move them.
 *   - dev: dev-loop's runner (src/roles/dev/phase.ts) plus the merged-PR
 *     reconciliation pass, from the repo root.
 * Both spawn `claude -p` through core/spawn-claude.ts, with
 * `--max-budget-usd` = the role's v1 `maxCostPerRunUsd` and a hard kill at
 * its `runTimeoutMin`.
 *
 * This file is deliberately the untested composition root -- every piece of
 * logic it uses already has vitest coverage against injected fakes; this is
 * the real-IO wiring those fakes stand in for.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  loadConfig,
  loadLoopConfig,
  assertNoPlaceholders,
  repoSlugFromUrl,
  targetRepoAddDir,
  resolveProjectConfigPath,
} from "./core/config.ts";
import type { Config, LoopConfig } from "./core/types.ts";
import { credentialsFromEnv, assigneeAccountIdFromEnv, RealJiraClient } from "./core/jira-client.ts";
import type { JiraCredentials, JiraTicket } from "./core/jira-client.ts";
import { RealGitHubClient, realExecGh } from "./core/github-client.ts";
import { countRunsToday } from "./core/runs-log.ts";
import { snapshotRunDirs, findNewestRunDir } from "./core/run-dirs.ts";
import { readVerdictFile, agentErrorVerdict } from "./core/verdict.ts";
import { redactSensitive } from "./core/redact.ts";
import { decideNextAction } from "./core/poll-loop.ts";
import { buildRefineJql } from "./core/jql.ts";
import { spawnClaudeRun, startProgressTail, killedTimeoutVerdict } from "./core/spawn-claude.ts";
import { runLoopIteration as runDevIteration } from "./roles/dev/phase.ts";
import type { RunSkillFn as DevRunSkillFn } from "./roles/dev/phase.ts";
import { reconcileMergedTickets, realExecGhPrView, realExecGhFindMergedPr } from "./roles/dev/reconcile.ts";
import { ALLOWED_TOOLS as DEV_ALLOWED_TOOLS } from "./roles/dev/tools.ts";
import { runLoopIteration as runResearchIteration } from "./roles/research/phase.ts";
import type { RunSkillFn as ResearchRunSkillFn, RunSkillResult } from "./roles/research/phase.ts";
import { ALLOWED_TOOLS as RESEARCH_ALLOWED_TOOLS } from "./roles/research/tools.ts";
import {
  assertResearchRoot,
  researchClaudeMdExcludes,
  REFINE_SKILL_MD_PATH,
} from "./roles/research/startup.ts";

type Phase = "research" | "dev";

const MODEL = "sonnet";
const SKILL_NAME: Record<Phase, string> = { research: "ticket-refine", dev: "ticket-to-pr" };

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
function claudeEnvFor(config: Config): NodeJS.ProcessEnv {
  // Align the CLI's own internal background-task wait ceiling with this
  // project's own runTimeoutMin ceiling, computed from config so the two
  // can never drift out of sync -- without this, a subagent that
  // legitimately runs long gets its whole headless session killed at the
  // CLI's 600s default, well before this project's own timeout would have
  // caught it.
  return {
    ...process.env,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(config.ceilings.runTimeoutMin * 60_000),
  };
}

interface PhaseContext {
  config: Config;
  loopConfig: LoopConfig;
  once: boolean;
  stream: boolean;
  credentials: JiraCredentials;
  assigneeAccountId: string;
  jiraClient: RealJiraClient;
  githubClient: RealGitHubClient;
  slug: string;
  runsLogPath: string;
  runsBaseDir: string;
  rawUsageDir: string;
  /** CLAUDE.md files the spawned claude must not load (research: dev's root CLAUDE.md). */
  excludeClaudeMd: string[];
}

function rawUsagePathFor(ctx: PhaseContext, ticketKey: string, started: string): string {
  return join(ctx.rawUsageDir, `${ticketKey}-${started.replace(/[:.]/g, "")}.json`);
}

// ---------------------------------------------------------------------------
// --phase research: research-loop's v1 main loop.
// ---------------------------------------------------------------------------

async function runResearchPhase(ctx: PhaseContext): Promise<void> {
  const skill = SKILL_NAME.research;
  const { config, loopConfig, once, stream, credentials, jiraClient, githubClient } = ctx;
  const skillVersion = gitFileSha(REFINE_SKILL_MD_PATH);
  const jql = buildRefineJql(config);

  log(`[${skill}] loop started, polling every ${loopConfig.pollIntervalSec}s (project: ${ctx.slug})`);

  const runSkill: ResearchRunSkillFn = async (ticket: JiraTicket): Promise<RunSkillResult> => {
    const before = await snapshotRunDirs(ctx.runsBaseDir, ticket.key);

    log(`[${skill}] claimed ${ticket.key}, running...`);

    try {
      const existingIssue = await githubClient.findIssueByJiraKey(ticket.key);
      if (existingIssue) {
        log(`[${skill}] ${ticket.key}: GitHub Issue already exists (${existingIssue.url}), skipping creation`);
      } else {
        const issue = await githubClient.createIssue({
          title: `${ticket.key}: (refinement in progress)`,
          body: `Mirror of [${ticket.key}](${credentials.baseUrl}/browse/${ticket.key}). ticket-refine is running -- this Issue will be updated with recon/attack/verify findings per the routing rule as the run progresses.`,
          jiraKey: ticket.key,
        });
        log(`[${skill}] ${ticket.key}: created GitHub Issue ${issue.url}`);
      }
    } catch (err) {
      // A GitHub Issue creation failure must never block the actual
      // ticket-refine run -- same "never throw out of runSkill" contract
      // every other I/O boundary in this function already follows. Log it
      // and let ticket-refine run without a mirror Issue this time; a
      // future run will retry (findIssueByJiraKey will find nothing and
      // try again).
      const message = err instanceof Error ? err.message : String(err);
      logError(`[${skill}] ${ticket.key}: GitHub Issue creation/lookup failed: ${message}`);
    }

    const tail = startProgressTail(ctx.runsBaseDir, ticket.key, before, skill, log);
    const startedForPath = new Date().toISOString();
    const run = await spawnClaudeRun(
      {
        prompt: `/${skill} ${ticket.key}`,
        model: MODEL,
        allowedTools: RESEARCH_ALLOWED_TOOLS,
        addDir: null,
        excludeClaudeMd: ctx.excludeClaudeMd,
        timeoutMin: config.ceilings.runTimeoutMin,
        maxBudgetUsd: config.ceilings.maxCostPerRunUsd,
        stream,
        ticketKey: ticket.key,
        rawUsagePath: rawUsagePathFor(ctx, ticket.key, startedForPath),
        env: claudeEnvFor(config),
      },
      { logPrefix: skill, log, logError },
    );
    await tail.stop();

    const durationMin = (new Date(run.ended).getTime() - new Date(run.started).getTime()) / 60000;
    const base = {
      skill,
      skillVersion,
      model: MODEL,
      startedAt: run.started,
      endedAt: run.ended,
      durationMin,
    };

    if (run.killedTimeout) {
      return {
        ...base,
        verdictRaw: JSON.stringify(killedTimeoutVerdict(config.ceilings.runTimeoutMin)),
        costUsd: run.usage.costUsd,
        tokens: run.usage.tokens,
      };
    }
    if (run.spawnError !== undefined) {
      // A spawn failure must never throw out of runSkill. Treat it the same
      // as a missing verdict.json: the loop records an agent_error and
      // keeps polling.
      return { ...base, verdictRaw: undefined, costUsd: 0, tokens: { in: 0, out: 0 } };
    }

    const runDirName = await findNewestRunDir(ctx.runsBaseDir, ticket.key, before);
    let verdictRaw: string | undefined;
    if (runDirName) {
      try {
        // Redacted before it ever leaves this function -- verdict.json is
        // the skill's own self-report and could echo back a secret-shaped
        // value it encountered during Ground; this is what lands in
        // runs.jsonl's `detail` field.
        verdictRaw = redactSensitive(
          await readFile(join(ctx.runsBaseDir, runDirName, "verdict.json"), "utf8"),
        );
      } catch {
        verdictRaw = undefined;
      }
    }
    if (verdictRaw === undefined) {
      logNoVerdictDiagnostics(skill, ticket.key, run.stdout);
    }

    return { ...base, verdictRaw, costUsd: run.usage.costUsd, tokens: run.usage.tokens };
  };

  for (;;) {
    const runsToday = await countRunsToday(ctx.runsLogPath, new Date());
    const result = await runResearchIteration({
      jiraClient,
      config,
      jql,
      runSkill,
      runsLogPath: ctx.runsLogPath,
      runsToday,
      assigneeAccountId: ctx.assigneeAccountId,
    });

    for (const key of result.skippedLanded ?? []) {
      log(`[${skill}] ${key}: skipped, already landed (runs.jsonl has a landed run); not re-refining`);
    }

    switch (result.action) {
      case "empty-queue":
        log(`[${skill}] queue empty, sleeping ${loopConfig.pollIntervalSec}s`);
        break;
      case "claim-raced":
        log(`[${skill}] claim raced on ${result.ticket}, retrying`);
        break;
      case "claim-error":
        logError(
          `[${skill}] ${result.ticket}: claim() failed (${result.jiraSyncError}) -- skipping this ticket rather than crashing the loop. This is likely a Jira transition screen requiring a field claim() doesn't send (see docs/future-enhancements.md); fix the ticket/transition manually, then it will be retried on the next poll.`,
        );
        break;
      case "processed":
        log(`[${skill}] ${result.ticket}: ${result.logLine?.detail}`);
        if (result.jiraSyncError) {
          logError(
            `[${skill}] ${result.ticket}: WARNING -- Jira label/status update failed (${result.jiraSyncError}). The run is logged in runs.jsonl, but Jira's label/status may not reflect it -- check and fix manually.`,
          );
        }
        log(
          `[${skill}] waiting ${loopConfig.postRunDelaySec}s before re-polling, so Jira's search index catches up with the just-written status transition`,
        );
        break;
      case "paused-ceiling":
        logError(`[${skill}] PAUSED: ${result.pauseReason}`);
        process.exit(1);
    }

    const nextAction = decideNextAction(result.action, loopConfig, once);
    if (nextAction.kind === "exit") return;
    if (nextAction.kind === "sleep") await sleep(nextAction.ms);
  }
}

// ---------------------------------------------------------------------------
// --phase dev: dev-loop's v1 main loop.
// ---------------------------------------------------------------------------

async function runDevPhase(ctx: PhaseContext): Promise<void> {
  const skill = SKILL_NAME.dev;
  const { config, loopConfig, once, stream, jiraClient, githubClient } = ctx;

  log(`[${skill}] loop started, polling every ${loopConfig.pollIntervalSec}s (project: ${ctx.slug})`);

  const runSkill: DevRunSkillFn = async (ticketKey: string) => {
    const before = await snapshotRunDirs(ctx.runsBaseDir, ticketKey);

    log(`[${skill}] claimed ${ticketKey}, running...`);
    const tail = startProgressTail(ctx.runsBaseDir, ticketKey, before, skill, log);

    // --permission-mode acceptEdits only auto-answers the Edit/Write
    // permission *prompt* -- it does not grant tool access to a directory
    // outside this process's cwd. ticket-to-pr's worktrees live inside
    // targetRepo.path (when set), so without --add-dir every Edit/Write
    // into the worktree is denied (confirmed live on TARS-1393).
    const startedForPath = new Date().toISOString();
    const run = await spawnClaudeRun(
      {
        prompt: `/${skill} ${ticketKey}`,
        model: MODEL,
        allowedTools: DEV_ALLOWED_TOOLS,
        addDir: targetRepoAddDir(config),
        timeoutMin: config.ceilings.runTimeoutMin,
        maxBudgetUsd: config.ceilings.maxCostPerRunUsd,
        stream,
        ticketKey,
        rawUsagePath: rawUsagePathFor(ctx, ticketKey, startedForPath),
        env: claudeEnvFor(config),
      },
      { logPrefix: skill, log, logError },
    );
    await tail.stop();

    if (run.killedTimeout) {
      return {
        verdict: killedTimeoutVerdict(config.ceilings.runTimeoutMin),
        started: run.started,
        ended: run.ended,
        costUsd: run.usage.costUsd,
        tokens: run.usage.tokens,
      };
    }
    if (run.spawnError !== undefined) {
      // A spawn failure must never throw out of runSkill -- treat it the
      // same as a missing verdict.json: the loop records an agent_error.
      return {
        verdict: agentErrorVerdict(run.spawnError),
        started: run.started,
        ended: run.ended,
        costUsd: 0,
        tokens: { in: 0, out: 0 },
      };
    }

    const runDirName = await findNewestRunDir(ctx.runsBaseDir, ticketKey, before);
    let verdict = runDirName
      ? await readVerdictFile(join(ctx.runsBaseDir, runDirName, "verdict.json"), "executor")
      : agentErrorVerdict("no run directory appeared for this ticket");
    // verdict.detail is the skill's own self-report and could echo back a
    // secret-shaped value; it lands in runs.jsonl's `detail` field.
    verdict = { ...verdict, detail: redactSensitive(verdict.detail) };

    if (!runDirName || verdict.failure_category === "agent_error") {
      logNoVerdictDiagnostics(skill, ticketKey, run.stdout);
    }

    return {
      verdict,
      started: run.started,
      ended: run.ended,
      costUsd: run.usage.costUsd,
      tokens: run.usage.tokens,
    };
  };

  const execGhPrView = realExecGhPrView();
  const reconciled = new Set<string>();

  for (;;) {
    try {
      const reconcileResult = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config,
        runsLogPath: ctx.runsLogPath,
        execGhPrView,
        execGhFindMergedPr: realExecGhFindMergedPr(config.github.repo),
        reconciled,
      });
      if (reconcileResult.closed.length > 0) {
        log(`[${skill}] reconciliation: merged PR(s) reconciled (mirror Issue closed, pipeline label removed) for ${reconcileResult.closed.join(", ")}`);
      }
      for (const err of reconcileResult.errors) {
        logError(`[${skill}] reconciliation: ${err.ticket}: ${err.message}`);
      }
    } catch (err) {
      // The reconciliation pass itself must never throw out of the poll
      // loop. A failure here just means this cycle's reconciliation didn't
      // run; the next cycle tries again.
      const message = err instanceof Error ? err.message : String(err);
      logError(`[${skill}] reconciliation pass failed: ${message}`);
    }

    const runsToday = await countRunsToday(ctx.runsLogPath, new Date());
    const result = await runDevIteration({
      jiraClient,
      githubClient,
      config,
      runSkill,
      loopKind: "dev",
      runsLogPath: ctx.runsLogPath,
      runsToday,
      assigneeAccountId: ctx.assigneeAccountId,
      execGhPrView,
    });

    switch (result.kind) {
      case "idle":
        for (const s of result.skipped ?? []) {
          log(`[${skill}] ${s.ticket}: skipped, ${s.reason}`);
        }
        log(`[${skill}] queue empty, sleeping ${loopConfig.pollIntervalSec}s`);
        break;
      case "skipped-race":
        log(`[${skill}] claim raced on ${result.ticket}, retrying`);
        break;
      case "ran":
        log(`[${skill}] ${result.ticket}: ${result.logLine.detail}`);
        if (result.jiraSyncError) {
          logError(
            `[${skill}] ${result.ticket}: WARNING -- Jira label/status update failed (${result.jiraSyncError}). The run is logged in runs.jsonl, but Jira's label/status may not reflect it -- check and fix manually.`,
          );
        }
        log(
          `[${skill}] waiting ${loopConfig.postRunDelaySec}s before polling again (lets Jira's search index catch up with the just-written status)`,
        );
        break;
      case "paused":
        logError(`[${skill}] PAUSED: ${result.reason}`);
        process.exit(1);
    }

    const action = decideNextAction(result.kind, loopConfig, once);
    if (action.kind === "exit") return;
    if (action.kind === "sleep") await sleep(action.ms);
  }
}

// ---------------------------------------------------------------------------

let activePhase: Phase | null = null;

async function main(): Promise<void> {
  const { phase, project, configPath, once, stream } = parseArgs(process.argv.slice(2));
  activePhase = phase;

  // --config is relative to the caller's cwd, so resolve it before chdir.
  const absConfigPath = configPath !== undefined ? resolve(configPath) : undefined;
  const repoRoot = process.cwd();
  // Fail loudly, before any Jira/GitHub I/O, if the research root no longer
  // has the skill claude -p needs (e.g. .claude/ moved but PHASE_ROOT didn't).
  if (phase === "research") assertResearchRoot(PHASE_ROOT.research);
  // v1 research ran from its own repo and loaded only research-loop/CLAUDE.md;
  // here the parent dev CLAUDE.md would load too, so exclude it.
  const excludeClaudeMd =
    phase === "research" ? researchClaudeMdExcludes(repoRoot, PHASE_ROOT.research) : [];
  process.chdir(PHASE_ROOT[phase]);

  const resolvedConfigPath = absConfigPath ?? (await resolveProjectConfigPath(project));
  const config = await loadConfig(resolvedConfigPath);
  assertNoPlaceholders(config, phase);
  const loopConfig = await loadLoopConfig();

  const credentials = credentialsFromEnv();
  const assigneeAccountId = assigneeAccountIdFromEnv();
  const jiraClient = new RealJiraClient(credentials, config);
  const githubClient = new RealGitHubClient(config.github, realExecGh());

  const slug = repoSlugFromUrl(config.targetRepo.url);
  await mkdir("runs", { recursive: true });
  const rawUsageDir = join(".pipeline", slug, "raw-usage");
  await mkdir(rawUsageDir, { recursive: true });

  const ctx: PhaseContext = {
    config,
    loopConfig,
    once,
    stream,
    credentials,
    assigneeAccountId,
    jiraClient,
    githubClient,
    slug,
    runsLogPath: join("runs", `${slug}.jsonl`),
    runsBaseDir: join(".pipeline", slug, "runs"),
    rawUsageDir,
    excludeClaudeMd,
  };

  if (phase === "research") {
    await runResearchPhase(ctx);
  } else {
    await runDevPhase(ctx);
  }
}

main().catch((err) => {
  const prefix = activePhase ? SKILL_NAME[activePhase] : "main";
  logError(`[${prefix}] fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
