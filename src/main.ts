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
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadConfig,
  loadLoopConfig,
  assertNoPlaceholders,
  repoSlugFromUrl,
} from "./config.ts";
import { credentialsFromEnv, assigneeAccountIdFromEnv, RealJiraClient } from "./jira-client.ts";
import { runLoopIteration } from "./loop-runner.ts";
import type { RunSkillFn } from "./loop-runner.ts";
import { countRunsToday } from "./runs-log.ts";
import { snapshotRunDirs, findNewestRunDir } from "./run-dirs.ts";
import { extractUsage } from "./claude-usage.ts";
import { readVerdictFile, agentErrorVerdict } from "./verdict.ts";
import { redactPII } from "./redact.ts";

const SKILL_NAME = "ticket-to-pr";
const MODEL = "sonnet";

/**
 * --permission-mode acceptEdits only auto-approves file edits, not MCP
 * tool calls or Bash -- Atlassian MCP calls (getJiraIssue, etc.) and every
 * Bash invocation (git worktree/push, running the test suite, lint/
 * typecheck/build, `gh pr create`) still prompt for approval, which
 * hangs/fails in headless -p mode. ticket-to-pr only ever reads the
 * ticket itself via MCP (fetches summary/description/comments/status); it
 * never transitions status, moves epics, or writes comments through MCP
 * -- the loop runner's REST client handles all of that. Bash is allowed
 * broadly since every TDD phase (Red/Green/Verify/PR) assumes real
 * command execution inside the isolated per-run worktree.
 */
const ALLOWED_TOOLS = [
  "mcp__atlassian__getAccessibleAtlassianResources",
  "mcp__atlassian__getJiraIssue",
  "Bash",
].join(",");

function parseArgs(
  argv: string[],
): { configPath: string; once: boolean; stream: boolean } {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex !== -1 ? argv[configIndex + 1] : undefined;
  if (!configPath) {
    throw new Error(
      "main.ts requires --config <path-to-pipeline.<project>.config.json>",
    );
  }
  return {
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
 * process prints goes through redactPII() first, so an email address (and,
 * on machines where $HOME is email-shaped, any absolute path containing
 * it) never reaches the terminal or a captured log, regardless of whether
 * it came from our own message or from something a spawned `claude`
 * process/subagent tool call printed.
 */
function log(message: string): void {
  console.log(redactPII(message));
}

function logError(message: string): void {
  console.error(redactPII(message));
}

/**
 * Polls a run's own progress.jsonl (which the skill writes to live, phase
 * by phase, while it works) and prints each new line to the terminal as
 * it appears -- so a human watching the foreground process sees
 * intake/plan/red/green/verify/pr scroll by instead of a silent
 * multi-minute gap between "claimed" and the final result. `before` is
 * the run-dir snapshot taken just before spawning, same as run-dirs.ts's
 * own before/after discovery -- this reuses it rather than re-snapshotting.
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
        log(`[${SKILL_NAME}] ${ticketKey} ${event.phase} ${event.event}: ${event.detail}`);
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

/**
 * Line-buffers a readable stream and calls onLine per complete line --
 * shared by both spawn functions' stderr handling below, since stderr is
 * never inherited (that would print an unredacted child-process line
 * straight to the terminal, bypassing redactPII() entirely).
 */
function onLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffered = "";
  stream.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) onLine(line);
    }
  });
}

/** Spawns `claude` with the given args and resolves with its stdout. */
function spawnClaude(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    onLines(child.stderr, (line) => logError(`[${SKILL_NAME}] (stderr) ${line}`));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}. Output: ${stdout.slice(-2000)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Prints one line per interesting `stream-json` event -- tool calls and
 * their results -- so a human watching `--stream` sees live activity
 * instead of a silent multi-minute gap. Skips system/hook noise and raw
 * thinking blocks (too verbose to be useful live). Truncates any printed
 * input/content so a large file read/write doesn't flood the terminal.
 */
function printStreamEvent(parsed: unknown, ticketKey: string): void {
  const truncate = (value: unknown): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 200)}...` : text;
  };

  if (typeof parsed !== "object" || parsed === null) return;
  const event = parsed as Record<string, unknown>;

  if (event.type === "assistant") {
    const content = (event.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (item?.type === "tool_use") {
        log(
          `[${SKILL_NAME}] ${ticketKey} tool_use: ${item.name} ${truncate(item.input)}`,
        );
      }
    }
  } else if (event.type === "user") {
    const content = (event.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (item?.type === "tool_result") {
        log(
          `[${SKILL_NAME}] ${ticketKey} tool_result: ${truncate(item.content)}`,
        );
      }
    }
  }
}

/**
 * Streaming counterpart to spawnClaude: appends --output-format stream-json
 * --verbose, calls onEvent(parsedLine) per line for live printing, and
 * returns just the final result line's raw text -- so the return contract
 * matches spawnClaude's (a JSON string extractUsage() can parse unchanged),
 * even though many lines were read along the way. Falls back to the last
 * line seen if no "result"-typed line ever appeared (e.g. the process was
 * killed mid-stream).
 */
function spawnClaudeStreaming(
  args: string[],
  env: NodeJS.ProcessEnv,
  onEvent: (parsed: unknown) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [...args, "--output-format", "stream-json", "--verbose"],
      { stdio: ["ignore", "pipe", "pipe"], env },
    );
    let lastLine = "";
    let resultLine: string | null = null;

    onLines(child.stdout, (line) => {
      lastLine = line;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type === "result") {
          resultLine = line;
        }
        onEvent(parsed);
      } catch {
        // Malformed stream line -- skip it, never let it crash the loop.
      }
    });
    onLines(child.stderr, (line) => logError(`[${SKILL_NAME}] (stderr) ${line}`));
    child.on("error", reject);
    child.on("close", (code) => {
      const finalLine = resultLine ?? lastLine;
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}. Last line: ${finalLine.slice(-2000)}`));
        return;
      }
      resolve(finalLine);
    });
  });
}

async function main(): Promise<void> {
  const { configPath, once, stream } = parseArgs(process.argv.slice(2));

  const config = await loadConfig(configPath);
  assertNoPlaceholders(config);
  const loopConfig = await loadLoopConfig();

  const credentials = credentialsFromEnv();
  const assigneeAccountId = assigneeAccountIdFromEnv();
  const jiraClient = new RealJiraClient(credentials, config);

  const slug = repoSlugFromUrl(config.targetRepo.url);
  await mkdir("runs", { recursive: true });
  const runsLogPath = join("runs", `${slug}.jsonl`);
  const runsBaseDir = join(".pipeline", slug, "runs");

  log(
    `[${SKILL_NAME}] loop started, polling every ${loopConfig.pollIntervalSec}s (project: ${slug})`,
  );

  const runSkill: RunSkillFn = async (ticketKey: string) => {
    const started = new Date().toISOString();
    const before = await snapshotRunDirs(runsBaseDir, ticketKey);

    log(`[${SKILL_NAME}] claimed ${ticketKey}, running...`);
    const tail = startProgressTail(runsBaseDir, ticketKey, before);

    const claudeArgs = [
      "-p",
      `/${SKILL_NAME} ${ticketKey}`,
      "--model",
      MODEL,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ALLOWED_TOOLS,
      "--output-format",
      "json",
    ];
    // Align the CLI's own internal background-task wait ceiling with this
    // project's own runTimeoutMin ceiling, computed from config so the two
    // can never drift out of sync -- without this, a subagent that
    // legitimately runs long gets its whole headless session killed at
    // the CLI's 600s default, well before this project's own timeout
    // would have caught it.
    const claudeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(config.ceilings.runTimeoutMin * 60_000),
    };

    let stdout: string;
    try {
      stdout = stream
        ? await spawnClaudeStreaming(claudeArgs, claudeEnv, (line) =>
            printStreamEvent(line, ticketKey),
          )
        : await spawnClaude(claudeArgs, claudeEnv);
    } catch (err) {
      // A spawn failure (nonzero exit, transient auth/network error, etc.)
      // must never throw out of runSkill -- that would propagate out of
      // the for(;;) loop in main() and kill the entire unattended process
      // over what should be just one failed run. Treat it the same as a
      // missing verdict.json: log it, let the loop record an agent_error
      // and keep polling.
      const message = err instanceof Error ? err.message : String(err);
      logError(`[${SKILL_NAME}] ${ticketKey}: spawn failed: ${message}`);
      await tail.stop();
      return {
        verdict: agentErrorVerdict(message),
        started,
        ended: new Date().toISOString(),
        costUsd: 0,
      };
    }

    const ended = new Date().toISOString();
    await tail.stop();

    let usageRaw: unknown = null;
    try {
      usageRaw = JSON.parse(stdout);
    } catch {
      usageRaw = null;
    }
    const usage = extractUsage(usageRaw);

    const runDirName = await findNewestRunDir(runsBaseDir, ticketKey, before);
    let verdict;
    if (runDirName) {
      verdict = await readVerdictFile(join(runsBaseDir, runDirName, "verdict.json"));
    } else {
      verdict = agentErrorVerdict("no run directory appeared for this ticket");
    }

    if (!runDirName || verdict.failure_category === "agent_error") {
      // No verdict.json (or a malformed one) means the skill stopped
      // before writing one -- print whatever claude -p itself reported so
      // a human can see why, instead of just "agent_error" with no clue.
      try {
        const parsed = usageRaw as {
          result?: string;
          permission_denials?: Array<{ tool_name: string }>;
        } | null;
        if (parsed?.result) {
          logError(`[${SKILL_NAME}] ${ticketKey}: claude's own result text: ${parsed.result}`);
        }
        if (parsed?.permission_denials?.length) {
          const denied = parsed.permission_denials.map((d) => d.tool_name).join(", ");
          logError(`[${SKILL_NAME}] ${ticketKey}: permission denials: ${denied}`);
        }
      } catch {
        // Diagnostic logging must never itself crash the loop.
      }
    }

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
      assigneeAccountId,
    });

    switch (result.kind) {
      case "idle":
        log(
          `[${SKILL_NAME}] queue empty, sleeping ${loopConfig.pollIntervalSec}s`,
        );
        if (once) return;
        await sleep(loopConfig.pollIntervalSec * 1000);
        break;
      case "skipped-race":
        log(`[${SKILL_NAME}] claim raced on ${result.ticket}, retrying`);
        if (once) return;
        break;
      case "ran":
        log(`[${SKILL_NAME}] ${result.ticket}: ${result.logLine.detail}`);
        if (result.jiraSyncError) {
          logError(
            `[${SKILL_NAME}] ${result.ticket}: WARNING -- Jira epic/status update failed (${result.jiraSyncError}). The run is logged in runs.jsonl, but Jira's epic/status may not reflect it -- check and fix manually.`,
          );
        }
        if (once) return;
        break;
      case "paused":
        logError(`[${SKILL_NAME}] PAUSED: ${result.reason}`);
        process.exit(1);
    }
  }
}

main().catch((err) => {
  logError(`[${SKILL_NAME}] fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
