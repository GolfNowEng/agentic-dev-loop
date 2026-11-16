// Opens sbx's live dashboard (`npm run sbx:dashboard`, i.e. `sbx tui`) in a
// new Terminal window when a run uses --sandbox=sbx, so one command starts
// both. The dashboard is a full-screen TUI, so it needs its own window; it
// can't share the loop's output. Best effort: it never fails a run.

import { execFileSync } from "node:child_process";

export interface DashboardDeps {
  platform: NodeJS.Platform;
  /** A person at a terminal (stdin and stdout are TTYs). */
  interactive: boolean;
  /** True when an `sbx tui` is already running. */
  alreadyOpen: () => boolean;
  /** Runs a command without a shell; throws on failure. */
  exec: (cmd: string, args: string[]) => void;
  log: (msg: string) => void;
}

const MANUAL = "open it yourself in another window: npm run sbx:dashboard";

/** The shell command the new window runs: cd into the repo root, then the npm script. */
export function dashboardCommand(repoRoot: string): string {
  return `cd '${repoRoot.replace(/'/g, "'\\''")}' && npm run sbx:dashboard`;
}

/**
 * Opens the dashboard on macOS when someone is at the terminal and none is
 * open yet. The command reaches AppleScript as an argument (argv), never
 * spliced into the script text.
 */
export function openSbxDashboard(repoRoot: string, deps: DashboardDeps): "opened" | "skipped" | "failed" {
  if (deps.platform !== "darwin") {
    deps.log(`[sbx] dashboard not opened (macOS only); ${MANUAL}`);
    return "skipped";
  }
  if (!deps.interactive) return "skipped";
  if (deps.alreadyOpen()) {
    deps.log("[sbx] dashboard already open; not opening another");
    return "skipped";
  }
  try {
    deps.exec("osascript", [
      "-e", "on run argv",
      "-e", 'tell application "Terminal" to do script (item 1 of argv)',
      "-e", 'tell application "Terminal" to activate',
      "-e", "end run",
      dashboardCommand(repoRoot),
    ]);
    deps.log("[sbx] opened the sbx dashboard in a new Terminal window (skip it with --no-dashboard)");
    return "opened";
  } catch (err) {
    deps.log(`[sbx] could not open the dashboard (${err instanceof Error ? err.message : String(err)}); ${MANUAL}`);
    return "failed";
  }
}

/** The real dependencies. */
export function realDashboardDeps(log: (msg: string) => void): DashboardDeps {
  return {
    platform: process.platform,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    alreadyOpen: () => {
      try {
        execFileSync("pgrep", ["-f", "sbx tui"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    exec: (cmd, args) => {
      execFileSync(cmd, args, { stdio: "ignore", timeout: 10_000 });
    },
    log,
  };
}
