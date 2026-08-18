/**
 * CLI entrypoint: `node --env-file=.env src/main.ts --config <path> [--once]`.
 *
 * Wires the real Jira client and a real `claude -p` spawn into the already-
 * tested `runLoopIteration()`, then drives a poll/sleep loop around it. This
 * file is deliberately the untested composition root -- every piece of
 * logic it uses (config loading, ceilings, verdict parsing, run-dir
 * discovery, usage extraction, the loop iteration itself) already has full
 * vitest coverage against injected fakes; this is the real-IO wiring that
 * those fakes stand in for.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadConfig,
  loadLoopConfig,
  assertNoPlaceholders,
  repoSlugFromUrl,
} from "./config.ts";
import { credentialsFromEnv, RealJiraClient } from "./jira-client.ts";
import type { JiraTicket } from "./jira-client.ts";
import { runLoopIteration } from "./loop-runner.ts";
import type { RunSkillFn, RunSkillResult } from "./loop-runner.ts";
import { buildRefineJql } from "./jql.ts";
import { countRunsToday } from "./runs-log.ts";
import { snapshotRunDirs, findNewestRunDir } from "./run-dirs.ts";
import { extractUsage } from "./claude-usage.ts";

const SKILL_NAME = "ticket-refine";
const MODEL = "opus";
const SKILL_MD_PATH = ".claude/skills/ticket-refine/SKILL.md";

/**
 * --permission-mode acceptEdits only auto-approves file edits, not MCP
 * tool calls -- Atlassian MCP calls (getJiraIssue, etc.) still prompt for
 * approval, which hangs/fails in headless -p mode. Explicitly allow the
 * specific Atlassian MCP tools this skill actually uses (read + comment +
 * description writes -- ticket-refine never transitions status or moves
 * epics itself, the loop runner's REST client does that).
 */
const ALLOWED_TOOLS = [
  "mcp__atlassian__getAccessibleAtlassianResources",
  "mcp__atlassian__getJiraIssue",
  "mcp__atlassian__searchJiraIssuesUsingJql",
  "mcp__atlassian__addCommentToJiraIssue",
  "mcp__atlassian__editJiraIssue",
].join(",");

function parseArgs(argv: string[]): { configPath: string; once: boolean } {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex !== -1 ? argv[configIndex + 1] : undefined;
  if (!configPath) {
    throw new Error(
      "main.ts requires --config <path-to-pipeline.<project>.config.json>",
    );
  }
  return { configPath, once: argv.includes("--once") };
}

function gitFileSha(relativePath: string): string {
  return execFileSync("git", ["log", "-1", "--format=%H", "--", relativePath], {
    encoding: "utf8",
  }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls a run's own progress.jsonl (which the skill writes to live, phase
 * by phase, while it works) and prints each new line to the terminal as
 * it appears -- so a human watching the foreground process sees
 * triage/interpret/ground/... scroll by instead of a silent multi-minute
 * gap between "claimed" and the final result. `before` is the run-dir
 * snapshot taken just before spawning, same as run-dirs.ts's own
 * before/after discovery -- this reuses it rather than re-snapshotting.
 */
function startProgressTail(
  runsBaseDir: string,
  ticketKey: string,
  before: Set<string>,
): { stop: () => Promise<void> } {
  let runDirName: string | null = null;
  let linesPrinted = 0;

  async function poll(): Promise<void> {
    if (!runDirName) {
      runDirName = await findNewestRunDir(runsBaseDir, ticketKey, before);
      if (!runDirName) return;
    }
    let raw: string;
    try {
      raw = await readFile(join(runsBaseDir, runDirName, "progress.jsonl"), "utf8");
    } catch {
      return;
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines.slice(linesPrinted)) {
      try {
        const event = JSON.parse(line) as { phase: string; event: string; detail: string };
        console.log(`[${SKILL_NAME}] ${ticketKey} ${event.phase} ${event.event}: ${event.detail}`);
      } catch {
        // Malformed progress line -- never let a logging glitch crash the loop.
      }
    }
    linesPrinted = lines.length;
  }

  const interval = setInterval(() => {
    poll().catch(() => {});
  }, 2000);

  return {
    stop: async () => {
      clearInterval(interval);
      await poll().catch(() => {});
    },
  };
}

/** Spawns `claude` with the given args and resolves with its stdout. */
function spawnClaude(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function main(): Promise<void> {
  const { configPath, once } = parseArgs(process.argv.slice(2));

  const config = await loadConfig(configPath);
  assertNoPlaceholders(config);
  const loopConfig = await loadLoopConfig();

  const credentials = credentialsFromEnv();
  const jiraClient = new RealJiraClient(credentials, config);

  const slug = repoSlugFromUrl(config.targetRepo.url);
  await mkdir("runs", { recursive: true });
  const runsLogPath = join("runs", `${slug}.jsonl`);
  const runsBaseDir = join(".pipeline", slug, "runs");

  const skillVersion = gitFileSha(SKILL_MD_PATH);
  const jql = buildRefineJql(config);

  console.log(
    `[${SKILL_NAME}] loop started, polling every ${loopConfig.pollIntervalSec}s (project: ${slug})`,
  );

  const runSkill: RunSkillFn = async (ticket: JiraTicket): Promise<RunSkillResult> => {
    const startedAt = new Date().toISOString();
    const before = await snapshotRunDirs(runsBaseDir, ticket.key);

    console.log(`[${SKILL_NAME}] claimed ${ticket.key}, running...`);
    const tail = startProgressTail(runsBaseDir, ticket.key, before);

    const stdout = await spawnClaude([
      "-p",
      `/${SKILL_NAME} ${ticket.key}`,
      "--model",
      MODEL,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ALLOWED_TOOLS,
      "--output-format",
      "json",
    ]);

    const endedAt = new Date().toISOString();
    await tail.stop();

    let usageRaw: unknown = null;
    try {
      usageRaw = JSON.parse(stdout);
    } catch {
      usageRaw = null;
    }
    const usage = extractUsage(usageRaw);

    const runDirName = await findNewestRunDir(runsBaseDir, ticket.key, before);
    let verdictRaw: string | undefined;
    if (runDirName) {
      try {
        verdictRaw = await readFile(join(runsBaseDir, runDirName, "verdict.json"), "utf8");
      } catch {
        verdictRaw = undefined;
      }
    }

    const durationMin =
      (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000;

    return {
      skill: SKILL_NAME,
      skillVersion,
      model: MODEL,
      startedAt,
      endedAt,
      verdictRaw,
      durationMin,
      costUsd: usage.costUsd,
    };
  };

  for (;;) {
    const runsToday = await countRunsToday(runsLogPath, new Date());
    const result = await runLoopIteration({
      jiraClient,
      config,
      jql,
      runSkill,
      runsLogPath,
      runsToday,
    });

    switch (result.action) {
      case "empty-queue":
        console.log(
          `[${SKILL_NAME}] queue empty, sleeping ${loopConfig.pollIntervalSec}s`,
        );
        if (once) return;
        await sleep(loopConfig.pollIntervalSec * 1000);
        break;
      case "claim-raced":
        console.log(`[${SKILL_NAME}] claim raced on ${result.ticket}, retrying`);
        if (once) return;
        break;
      case "processed":
        console.log(`[${SKILL_NAME}] ${result.ticket}: ${result.logLine?.detail}`);
        if (once) return;
        break;
      case "paused-ceiling":
        console.error(`[${SKILL_NAME}] PAUSED: ${result.pauseReason}`);
        process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`[${SKILL_NAME}] fatal error:`, err);
  process.exit(1);
});
