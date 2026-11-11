// Deterministic "start this project fresh" reset -- scoped to this
// repo's own local, gitignored state for one project slug. Deletes nothing this
// repo doesn't already consider disposable scratch space (runs.jsonl
// lines, .pipeline/<slug>/ run dirs, this repo's own worktrees under
// targetRepo.path). Never touches Jira, GitHub, the target repo's git
// history, or any other project's data.
//
// Split into a pure planReset() (what would be deleted, given directory
// listings this module reads) and a separate executeReset() (the actual
// fs.rm/appendFile calls) so the decision logic is unit-testable without
// touching a real filesystem, and so --dry-run can share the exact same
// plan the real run acts on -- no risk of the two ever silently diverging.

import { readFile, writeFile, appendFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./types.ts";

/**
 * Shorten a path under the home directory to ~/... for display only --
 * describeResetPlan/describeResetSummary output, never the ResetPlan/
 * ResetSummary objects themselves (those keep real absolute paths, since
 * executeReset and its tests need them unambiguous). Falls back to the
 * original path when it isn't under the home directory at all (e.g. a
 * test fixture's synthetic /repo/... paths).
 */
function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export interface ResetPlan {
  /** The ticket this plan was built for, or null for a whole-project reset. */
  ticketKey: string | null;
  /** .pipeline/<slug>/ itself -- only ever deleted wholesale for a whole-project reset (wholeProject: true); a per-ticket reset deletes individual entries under it instead (runDirsToRemove/rawUsageFilesToRemove), never this whole directory. */
  pipelineDir: string;
  /** Absolute/relative path to runs/<slug>.jsonl, or null if it doesn't exist. */
  runsLogPath: string | null;
  /** Always runs/<slug>.reset-archive.jsonl -- where removed lines get appended instead of deleted outright. Never overwritten, only ever appended to. */
  runsLogArchivePath: string;
  /** How many of runs/<slug>.jsonl's lines belong to this ticket (0 if runsLogPath is null, or ticketKey is undefined -- whole-project reset keeps the log file, see below). */
  runsLogLinesToRemove: number;
  /** .pipeline/<slug>/runs/<TICKET>-<RUN_ID>/ directories to delete. */
  runDirsToRemove: string[];
  /** .pipeline/<slug>/raw-usage/<TICKET>-<...>.json files to delete. */
  rawUsageFilesToRemove: string[];
  /** This repo's own <targetRepo.path>/.claude/worktrees/<TICKET>-<...> directories to delete, if targetRepo.path is set. Empty for a whole-project reset -- worktrees are always per-ticket by name, there is no "all of them for this project" grouping to key off safely without touching another project's worktrees that might share the same targetRepo.path. */
  worktreesToRemove: string[];
  /** Whether this is a whole-project reset (no ticketKey given) -- deletes runs/<slug>.jsonl and .pipeline/<slug>/ entirely instead of filtering by ticket. */
  wholeProject: boolean;
}

/**
 * List every top-level entry directly under `dir` whose name starts with
 * `prefix` -- used for both `.pipeline/<slug>/runs/<TICKET>-*` directories
 * and `.pipeline/<slug>/raw-usage/<TICKET>-*.json` files. Returns an empty
 * array if `dir` doesn't exist (nothing to remove is not an error here --
 * a project that never ran ticket-to-pr for this ticket has no directory
 * to clean up at all).
 */
async function listMatchingEntries(dir: string, prefix: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.startsWith(prefix)).sort();
}

/**
 * Count how many lines of a runs.jsonl file belong to `ticketKey`. Returns
 * 0 if the file doesn't exist or is empty -- same "nothing to do is not an
 * error" stance as listMatchingEntries.
 */
async function countTicketLogLines(path: string, ticketKey: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  const ticketField = `"ticket":"${ticketKey}"`;
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => line.includes(ticketField)).length;
}

/**
 * Compute what a reset would delete for `slug` (and, if given, one
 * `ticketKey` within it) under `repoRoot`. Read-only -- touches nothing on
 * disk beyond directory listings and a read of runs.jsonl to count
 * matching lines. `config` supplies `targetRepo.path` for the worktree
 * scan; pass null when no config was loadable (a --project the caller
 * hasn't resolved yet) -- worktreesToRemove is then always empty, since
 * there's no path to scan.
 */
export async function planReset(
  repoRoot: string,
  slug: string,
  ticketKey: string | undefined,
  config: Config | null,
): Promise<ResetPlan> {
  const runsLogPath = join(repoRoot, "runs", `${slug}.jsonl`);
  const runsLogArchivePath = join(repoRoot, "runs", `${slug}.reset-archive.jsonl`);
  const runsLogExists = await readFile(runsLogPath, "utf8").then(
    () => true,
    () => false,
  );

  const pipelineDir = join(repoRoot, ".pipeline", slug);
  const pipelineRunsDir = join(pipelineDir, "runs");
  const pipelineRawUsageDir = join(pipelineDir, "raw-usage");

  if (!ticketKey) {
    return {
      ticketKey: null,
      pipelineDir,
      runsLogPath: runsLogExists ? runsLogPath : null,
      runsLogArchivePath,
      runsLogLinesToRemove: 0,
      runDirsToRemove: [],
      rawUsageFilesToRemove: [],
      worktreesToRemove: [],
      wholeProject: true,
    };
  }

  const runDirNames = await listMatchingEntries(pipelineRunsDir, `${ticketKey}-`);
  const rawUsageNames = await listMatchingEntries(pipelineRawUsageDir, `${ticketKey}-`);
  const linesToRemove = runsLogExists ? await countTicketLogLines(runsLogPath, ticketKey) : 0;

  let worktreesToRemove: string[] = [];
  if (config?.targetRepo.path) {
    const worktreesDir = join(config.targetRepo.path, ".claude", "worktrees");
    const names = await listMatchingEntries(worktreesDir, `${ticketKey}-`);
    worktreesToRemove = names.map((name) => join(worktreesDir, name));
  }

  return {
    ticketKey,
    pipelineDir,
    runsLogPath: runsLogExists ? runsLogPath : null,
    runsLogArchivePath,
    runsLogLinesToRemove: linesToRemove,
    runDirsToRemove: runDirNames.map((name) => join(pipelineRunsDir, name)),
    rawUsageFilesToRemove: rawUsageNames.map((name) => join(pipelineRawUsageDir, name)),
    worktreesToRemove,
    wholeProject: false,
  };
}

export interface ResetSummary {
  runsLogLinesRemoved: number;
  /** Always equal to runsLogLinesRemoved -- kept as its own field so a caller can assert archiving actually happened, not just that lines were removed. */
  runsLogLinesArchived: number;
  archivePath: string;
  runDirsDeleted: string[];
  rawUsageFilesDeleted: string[];
  worktreesDeleted: string[];
  wholeProjectLogDeleted: boolean;
  pipelineDirDeleted: boolean;
}

/**
 * Apply a ResetPlan for real: archive removed runs.jsonl lines (never
 * delete them outright -- see runsLogArchivePath's own doc comment),
 * rewrite/delete the live log accordingly, delete every run dir /
 * raw-usage file / worktree the plan named. Deletions happen in an order
 * that leaves the plan's own paths orphaned rather than half-consistent
 * if interrupted mid-way (runs.jsonl last, since it's the most reversible
 * edit -- rewriting it wrong is a text fix; a deleted directory is gone).
 * Archiving happens before the live log is ever rewritten or deleted, so
 * an interruption between the two leaves (at worst) a harmless duplicate
 * in the append-only archive, never a lost line.
 */
export async function executeReset(plan: ResetPlan): Promise<ResetSummary> {
  for (const dir of plan.runDirsToRemove) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const file of plan.rawUsageFilesToRemove) {
    await rm(file, { force: true });
  }
  for (const dir of plan.worktreesToRemove) {
    await rm(dir, { recursive: true, force: true });
  }

  const summary: ResetSummary = {
    runsLogLinesRemoved: 0,
    runsLogLinesArchived: 0,
    archivePath: plan.runsLogArchivePath,
    runDirsDeleted: plan.runDirsToRemove,
    rawUsageFilesDeleted: plan.rawUsageFilesToRemove,
    worktreesDeleted: plan.worktreesToRemove,
    wholeProjectLogDeleted: false,
    pipelineDirDeleted: false,
  };

  if (plan.wholeProject) {
    if (plan.runsLogPath) {
      const raw = await readFile(plan.runsLogPath, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length > 0) {
        await appendFile(plan.runsLogArchivePath, `${lines.join("\n")}\n`, "utf8");
      }
      summary.runsLogLinesRemoved = lines.length;
      summary.runsLogLinesArchived = lines.length;
      await rm(plan.runsLogPath, { force: true });
      summary.wholeProjectLogDeleted = true;
    }
    await rm(plan.pipelineDir, { recursive: true, force: true });
    summary.pipelineDirDeleted = true;
    return summary;
  }

  if (plan.runsLogPath && plan.runsLogLinesToRemove > 0 && plan.ticketKey) {
    const raw = await readFile(plan.runsLogPath, "utf8");
    const ticketField = `"ticket":"${plan.ticketKey}"`;
    const allLines = raw.split("\n").filter((line) => line.trim().length > 0);
    const removed = allLines.filter((line) => line.includes(ticketField));
    const kept = allLines.filter((line) => !line.includes(ticketField));

    if (removed.length > 0) {
      await appendFile(plan.runsLogArchivePath, `${removed.join("\n")}\n`, "utf8");
    }
    const rewritten = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    await writeFile(plan.runsLogPath, rewritten, "utf8");

    summary.runsLogLinesRemoved = removed.length;
    summary.runsLogLinesArchived = removed.length;
  }

  return summary;
}

/**
 * Human-readable summary of a ResetPlan, for --dry-run output and for
 * confirming what a real run is about to do before it does it.
 */
export function describeResetPlan(plan: ResetPlan): string {
  if (plan.wholeProject) {
    const lines = [
      plan.runsLogPath
        ? `- delete runs.jsonl entirely (${shortenPath(plan.runsLogPath)})`
        : "- runs.jsonl: nothing to delete (file doesn't exist)",
      "- delete .pipeline/<slug>/ entirely (all runs, all raw-usage, every ticket)",
    ];
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push(
    plan.runsLogLinesToRemove > 0
      ? `- remove ${plan.runsLogLinesToRemove} line(s) from ${shortenPath(plan.runsLogPath ?? "")}`
      : "- runs.jsonl: no matching lines for this ticket",
  );
  lines.push(
    plan.runDirsToRemove.length > 0
      ? `- delete ${plan.runDirsToRemove.length} run dir(s): ${plan.runDirsToRemove.map(shortenPath).join(", ")}`
      : "- .pipeline/<slug>/runs/: no matching run dirs",
  );
  lines.push(
    plan.rawUsageFilesToRemove.length > 0
      ? `- delete ${plan.rawUsageFilesToRemove.length} raw-usage file(s): ${plan.rawUsageFilesToRemove.map(shortenPath).join(", ")}`
      : "- .pipeline/<slug>/raw-usage/: no matching files",
  );
  lines.push(
    plan.worktreesToRemove.length > 0
      ? `- delete ${plan.worktreesToRemove.length} worktree(s): ${plan.worktreesToRemove.map(shortenPath).join(", ")}`
      : "- targetRepo.path worktrees: none matching (or targetRepo.path unset)",
  );
  return lines.join("\n");
}

/**
 * Human-readable rendering of a ResetSummary -- what actually happened,
 * printed by reset-cli.ts after a real (non-dry-run) run. Distinct from
 * describeResetPlan, which describes what *would* happen.
 */
export function describeResetSummary(summary: ResetSummary): string {
  const lines: string[] = [];

  if (summary.wholeProjectLogDeleted || summary.pipelineDirDeleted) {
    lines.push(
      summary.wholeProjectLogDeleted
        ? `- runs.jsonl deleted (${summary.runsLogLinesRemoved} line(s) archived to ${shortenPath(summary.archivePath)})`
        : "- runs.jsonl: nothing to delete",
    );
    lines.push(
      summary.pipelineDirDeleted
        ? "- .pipeline/<slug>/ deleted"
        : "- .pipeline/<slug>/: nothing to delete",
    );
    return lines.join("\n");
  }

  lines.push(
    summary.runsLogLinesRemoved > 0
      ? `- ${summary.runsLogLinesRemoved} line(s) removed from runs.jsonl, archived to ${shortenPath(summary.archivePath)}`
      : "- runs.jsonl: no lines removed",
  );
  lines.push(
    summary.runDirsDeleted.length > 0
      ? `- ${summary.runDirsDeleted.length} run dir(s) deleted: ${summary.runDirsDeleted.map(shortenPath).join(", ")}`
      : "- no run dirs deleted",
  );
  lines.push(
    summary.rawUsageFilesDeleted.length > 0
      ? `- ${summary.rawUsageFilesDeleted.length} raw-usage file(s) deleted: ${summary.rawUsageFilesDeleted.map(shortenPath).join(", ")}`
      : "- no raw-usage files deleted",
  );
  lines.push(
    summary.worktreesDeleted.length > 0
      ? `- ${summary.worktreesDeleted.length} worktree(s) deleted: ${summary.worktreesDeleted.map(shortenPath).join(", ")}`
      : "- no worktrees deleted",
  );
  return lines.join("\n");
}
