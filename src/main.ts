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
} from "./config.js";
import { credentialsFromEnv, RealJiraClient } from "./jira-client.js";
import type { JiraTicket } from "./jira-client.js";
import { runLoopIteration } from "./loop-runner.js";
import type { RunSkillFn, RunSkillResult } from "./loop-runner.js";
import { buildRefineJql } from "./jql.js";
import { countRunsToday } from "./runs-log.js";
import { snapshotRunDirs, findNewestRunDir } from "./run-dirs.js";
import { extractUsage } from "./claude-usage.js";

const SKILL_NAME = "ticket-refine";
const MODEL = "opus";
const SKILL_MD_PATH = ".claude/skills/ticket-refine/SKILL.md";

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

  const runSkill: RunSkillFn = async (ticket: JiraTicket): Promise<RunSkillResult> => {
    const startedAt = new Date().toISOString();
    const before = await snapshotRunDirs(runsBaseDir, ticket.key);

    const stdout = await spawnClaude([
      "-p",
      `/${SKILL_NAME} ${ticket.key}`,
      "--model",
      MODEL,
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "json",
    ]);

    const endedAt = new Date().toISOString();

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
