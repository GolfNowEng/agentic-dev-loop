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

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  loadConfig,
  loadLoopConfig,
  assertNoPlaceholders,
  repoSlugFromUrl,
} from "./config.js";
import { credentialsFromEnv, RealJiraClient } from "./jira-client.js";
import { runLoopIteration } from "./loop-runner.js";
import type { RunSkillFn } from "./loop-runner.js";
import { countRunsToday } from "./runs-log.js";
import { snapshotRunDirs, findNewestRunDir } from "./run-dirs.js";
import { extractUsage } from "./claude-usage.js";
import { readVerdictFile, agentErrorVerdict } from "./verdict.js";

const SKILL_NAME = "ticket-to-pr";
const MODEL = "sonnet";

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

  const runSkill: RunSkillFn = async (ticketKey: string) => {
    const started = new Date().toISOString();
    const before = await snapshotRunDirs(runsBaseDir, ticketKey);

    const stdout = await spawnClaude([
      "-p",
      `/${SKILL_NAME} ${ticketKey}`,
      "--model",
      MODEL,
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "json",
    ]);

    const ended = new Date().toISOString();

    let usageRaw: unknown = null;
    try {
      usageRaw = JSON.parse(stdout);
    } catch {
      usageRaw = null;
    }
    const usage = extractUsage(usageRaw);

    const runDirName = await findNewestRunDir(runsBaseDir, ticketKey, before);
    const verdict = runDirName
      ? await readVerdictFile(join(runsBaseDir, runDirName, "verdict.json"))
      : agentErrorVerdict("no run directory appeared for this ticket");

    return { verdict, started, ended, costUsd: usage.costUsd };
  };

  for (;;) {
    const runsToday = await countRunsToday(runsLogPath, new Date());
    const result = await runLoopIteration({
      jiraClient,
      config,
      runSkill,
      loopKind: "dev",
      runsLogPath,
      runsToday,
    });

    switch (result.kind) {
      case "idle":
        console.log(
          `[${SKILL_NAME}] queue empty, sleeping ${loopConfig.pollIntervalSec}s`,
        );
        if (once) return;
        await sleep(loopConfig.pollIntervalSec * 1000);
        break;
      case "skipped-race":
        console.log(`[${SKILL_NAME}] claim raced on ${result.ticket}, retrying`);
        if (once) return;
        break;
      case "ran":
        console.log(`[${SKILL_NAME}] ${result.ticket}: ${result.logLine.detail}`);
        if (once) return;
        break;
      case "paused":
        console.error(`[${SKILL_NAME}] PAUSED: ${result.reason}`);
        process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`[${SKILL_NAME}] fatal error:`, err);
  process.exit(1);
});
