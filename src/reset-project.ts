// Deterministic "start this project fresh" reset -- scoped to dev-loop's
// own local, gitignored state for one project slug. Deletes nothing this
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

import { readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./types.ts";

export interface ResetPlan {
  /** The ticket this plan was built for, or null for a whole-project reset. */
  ticketKey: string | null;
  /** .pipeline/<slug>/ itself -- only ever deleted wholesale for a whole-project reset (wholeProject: true); a per-ticket reset deletes individual entries under it instead (runDirsToRemove/rawUsageFilesToRemove), never this whole directory. */
  pipelineDir: string;
  /** Absolute/relative path to runs/<slug>.jsonl, or null if it doesn't exist. */
  runsLogPath: string | null;
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
    runsLogLinesToRemove: linesToRemove,
    runDirsToRemove: runDirNames.map((name) => join(pipelineRunsDir, name)),
    rawUsageFilesToRemove: rawUsageNames.map((name) => join(pipelineRawUsageDir, name)),
    worktreesToRemove,
    wholeProject: false,
  };
}

/**
 * Apply a ResetPlan for real: rewrite runs.jsonl with the ticket's lines
 * removed (or delete it outright for a whole-project reset), delete every
 * run dir / raw-usage file / worktree the plan named. Deletions happen in
 * an order that leaves the plan's own paths orphaned rather than
 * half-consistent if interrupted mid-way (runs.jsonl last, since it's the
 * most reversible edit -- rewriting it wrong is a text fix; a deleted
 * directory is gone).
 */
export async function executeReset(plan: ResetPlan): Promise<void> {
  for (const dir of plan.runDirsToRemove) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const file of plan.rawUsageFilesToRemove) {
    await rm(file, { force: true });
  }
  for (const dir of plan.worktreesToRemove) {
    await rm(dir, { recursive: true, force: true });
  }

  if (plan.wholeProject) {
    if (plan.runsLogPath) {
      await rm(plan.runsLogPath, { force: true });
    }
    await rm(plan.pipelineDir, { recursive: true, force: true });
    return;
  }

  if (plan.runsLogPath && plan.runsLogLinesToRemove > 0 && plan.ticketKey) {
    const raw = await readFile(plan.runsLogPath, "utf8");
    const ticketField = `"ticket":"${plan.ticketKey}"`;
    const kept = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.includes(ticketField));
    const rewritten = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    await writeFile(plan.runsLogPath, rewritten, "utf8");
  }
}

/**
 * Human-readable summary of a ResetPlan, for --dry-run output and for
 * confirming what a real run is about to do before it does it.
 */
export function describeResetPlan(plan: ResetPlan): string {
  if (plan.wholeProject) {
    const lines = [
      plan.runsLogPath
        ? `- delete runs.jsonl entirely (${plan.runsLogPath})`
        : "- runs.jsonl: nothing to delete (file doesn't exist)",
      "- delete .pipeline/<slug>/ entirely (all runs, all raw-usage, every ticket)",
    ];
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push(
    plan.runsLogLinesToRemove > 0
      ? `- remove ${plan.runsLogLinesToRemove} line(s) from ${plan.runsLogPath}`
      : "- runs.jsonl: no matching lines for this ticket",
  );
  lines.push(
    plan.runDirsToRemove.length > 0
      ? `- delete ${plan.runDirsToRemove.length} run dir(s): ${plan.runDirsToRemove.join(", ")}`
      : "- .pipeline/<slug>/runs/: no matching run dirs",
  );
  lines.push(
    plan.rawUsageFilesToRemove.length > 0
      ? `- delete ${plan.rawUsageFilesToRemove.length} raw-usage file(s): ${plan.rawUsageFilesToRemove.join(", ")}`
      : "- .pipeline/<slug>/raw-usage/: no matching files",
  );
  lines.push(
    plan.worktreesToRemove.length > 0
      ? `- delete ${plan.worktreesToRemove.length} worktree(s): ${plan.worktreesToRemove.join(", ")}`
      : "- targetRepo.path worktrees: none matching (or targetRepo.path unset)",
  );
  return lines.join("\n");
}
