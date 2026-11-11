// Deterministic "start fresh" reset of this repo's own v2 pipeline state for
// one project (and optionally one ticket, and one role). Scope:
//   - runs/v2/<project>.jsonl records: archived to
//     runs/v2/<project>.reset-archive.jsonl (append-only), never just deleted;
//   - `<role>-<RUN_ID>` run dirs under .pipeline/v2/<project>/<session>/<ticket>/,
//     in every session;
//   - per-ticket only: leftover worktrees named for the ticket;
//   - whole-project, role all only: session-dir leftovers (.lock.adopted-*,
//     .acquire.stale-*/reclaim-*/release-*, .tmp-*), never a *.lock,
//     *.lock.stale-* (unadopted in-flight records) or the .acquire mutex.
// v1 history is never modified or deleted, in either layout: not runs/v1/**,
// .pipeline/v1/**, nor the pre-cutover runs/<slug>.jsonl, .pipeline/<slug>/,
// research-loop/runs/, research-loop/.pipeline/. Never touches Jira, GitHub,
// the target repo's git history, or another project's state.
//
// planReset() only reads; executeReset() acts on exactly that plan, and
// refuses any path outside the plan's own v2 roots, so --dry-run shows what
// the real run does.

import { appendFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { Config, Role } from "./types.ts";
import { resolveRepoPath, RUN_ID, SESSION_ID, TICKET_KEY, UnsafePathError, v2CloneDir, v2ProjectDir, v2RunsArchive, v2RunsLog, v2SessionsDir } from "./paths.ts";

export type ResetRole = Role | "all";

export interface ResetOptions {
  project: string;
  /** Omit for a whole-project reset. */
  ticket?: string;
  /** Default "all". */
  role?: ResetRole;
  /** Supplies targetRepo.path for the worktree scan; null/omitted = the v2 clone's worktrees only. */
  config?: Config | null;
  /** State root; defaults to the repo root. Tests pass a temp dir. */
  root?: string;
}

export interface ResetPlan {
  project: string;
  ticketKey: string | null;
  role: ResetRole;
  wholeProject: boolean;
  /** The state root every v2 path below lives under. */
  root: string;
  /** runs/v2/<project>.jsonl (absolute), whether or not it exists. */
  runsLogPath: string;
  runsLogExists: boolean;
  /** runs/v2/<project>.reset-archive.jsonl: archived records are appended here. */
  runsLogArchivePath: string;
  /** How many log lines will be archived (and removed from the live log). */
  recordsToArchive: number;
  /** `<role>-<RUN_ID>` dirs under .pipeline/v2/<project>/<session>/<ticket>/, sorted. */
  runDirsToRemove: string[];
  /** Whole-project role-all only: leftover files in .pipeline/v2/<project>/sessions/. */
  sessionLeftoversToRemove: string[];
  /** Per-ticket only: worktrees named for the ticket (role-scoped by name). */
  worktreesToRemove: string[];
  /** The worktrees dir scanned, or null. */
  worktreesDir: string | null;
  /** `<name>.lock` files in the sessions dir: a worker may be running; reset doesn't stop it. */
  liveLocks: string[];
}

export interface ResetSummary {
  recordsArchived: number;
  archivePath: string;
  runsLogDeleted: boolean;
  runDirsDeleted: string[];
  sessionLeftoversDeleted: string[];
  worktreesDeleted: string[];
}

/** Display only: ~/... for paths under the home directory. */
function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

async function list(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isDirectory(), () => false);
}

const RUN_DIR_NAME = /^(research|dev)-(.+)$/;

function runDirMatches(name: string, role: ResetRole): boolean {
  const m = RUN_DIR_NAME.exec(name);
  return m !== null && RUN_ID.test(m[2]) && (role === "all" || m[1] === role);
}

const LEFTOVER = [/\.lock\.adopted-/, /^\.acquire\.stale-/, /^\.acquire\.reclaim-/, /^\.acquire\.release-/, /^\.tmp-/];
const isLeftover = (name: string) => LEFTOVER.some((re) => re.test(name));
const isLock = (name: string) => name.endsWith(".lock") && !name.startsWith(".");

/** Does this log line belong to the reset? Unreadable lines only go with a whole-project role-all reset. */
function lineMatches(line: string, ticket: string | null, role: ResetRole): boolean {
  let r: { ticket?: unknown; phases?: unknown; resume?: unknown } | null;
  try {
    r = JSON.parse(line);
  } catch {
    return ticket === null && role === "all";
  }
  if (!r || typeof r !== "object") return ticket === null && role === "all";
  if (ticket !== null && r.ticket !== ticket) return false;
  if (role === "all") return true;
  const phases = Array.isArray(r.phases) ? (r.phases as Array<{ role?: unknown }>) : [];
  return phases.some((p) => p?.role === role) || r.resume === role;
}

async function readLines(path: string): Promise<string[] | null> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((l) => l.trim() !== "");
  } catch {
    return null;
  }
}

/** Compute what a reset would do. Read-only. */
export async function planReset(opts: ResetOptions): Promise<ResetPlan> {
  const role = opts.role ?? "all";
  if (role !== "all" && role !== "research" && role !== "dev") throw new Error(`role must be research, dev or all (got ${JSON.stringify(role)})`);
  const ticket = opts.ticket ?? null;
  if (ticket !== null && !TICKET_KEY.test(ticket)) throw new UnsafePathError(`ticket ${JSON.stringify(ticket)} must match ${TICKET_KEY}`);
  const at = (rel: string) => (opts.root === undefined ? resolveRepoPath(rel) : resolve(opts.root, rel));
  // runs/v2/<project>.jsonl is two levels below the state root.
  const root = opts.root === undefined ? resolve(resolveRepoPath(v2RunsLog(opts.project)), "../../..") : resolve(opts.root);

  const runsLogPath = at(v2RunsLog(opts.project));
  const lines = await readLines(runsLogPath);
  const recordsToArchive = (lines ?? []).filter((l) => lineMatches(l, ticket, role)).length;

  const projectDir = at(v2ProjectDir(opts.project));
  const sessionsDir = at(v2SessionsDir(opts.project));
  const cloneDir = at(v2CloneDir(opts.project));
  const runDirsToRemove: string[] = [];
  for (const s of await list(projectDir)) {
    const sDir = join(projectDir, s);
    if (!SESSION_ID.test(s) || sDir === sessionsDir || sDir === cloneDir || !(await isDir(sDir))) continue;
    for (const t of ticket !== null ? [ticket] : await list(sDir)) {
      if (!TICKET_KEY.test(t)) continue;
      const tDir = join(sDir, t);
      for (const name of await list(tDir)) {
        if (runDirMatches(name, role) && (await isDir(join(tDir, name)))) runDirsToRemove.push(join(tDir, name));
      }
    }
  }
  runDirsToRemove.sort();

  const sessionFiles = await list(sessionsDir);
  const sessionLeftoversToRemove =
    ticket === null && role === "all" ? sessionFiles.filter(isLeftover).map((f) => join(sessionsDir, f)) : [];
  const liveLocks = sessionFiles.filter(isLock).map((f) => join(sessionsDir, f));

  let worktreesDir: string | null = null;
  let worktreesToRemove: string[] = [];
  if (ticket !== null) {
    const base = opts.config?.targetRepo.path ?? (opts.config ? cloneDir : null);
    if (base) {
      worktreesDir = join(base, ".claude", "worktrees");
      worktreesToRemove = (await list(worktreesDir))
        .filter((n) => n.startsWith(`${ticket}-`))
        .filter((n) => role === "all" || (role === "research") === n.endsWith("-ground"))
        .map((n) => join(worktreesDir!, n));
    }
  }

  return {
    project: opts.project,
    ticketKey: ticket,
    role,
    wholeProject: ticket === null,
    root,
    runsLogPath,
    runsLogExists: lines !== null,
    runsLogArchivePath: at(v2RunsArchive(opts.project)),
    recordsToArchive,
    runDirsToRemove,
    sessionLeftoversToRemove,
    worktreesToRemove,
    worktreesDir,
    liveLocks,
  };
}

function assertUnder(path: string, base: string, what: string): void {
  if (!resolve(path).startsWith(resolve(base) + sep)) {
    throw new UnsafePathError(`refusing to delete ${JSON.stringify(path)}: ${what} outside ${base}`);
  }
}

/**
 * Apply a plan. Every path is checked first (nothing is deleted if one is
 * outside the plan's v2 roots). Dirs go first, the log last; archived lines
 * are appended before the live log is rewritten (temp file + rename), so an
 * interruption can at worst leave a duplicate in the archive.
 */
export async function executeReset(plan: ResetPlan): Promise<ResetSummary> {
  const projectDir = resolve(plan.root, v2ProjectDir(plan.project));
  const sessionsDir = resolve(plan.root, v2SessionsDir(plan.project));
  for (const d of plan.runDirsToRemove) assertUnder(d, projectDir, "run dir");
  for (const f of plan.sessionLeftoversToRemove) assertUnder(f, sessionsDir, "session leftover");
  for (const w of plan.worktreesToRemove) {
    if (!plan.worktreesDir) throw new UnsafePathError(`refusing to delete ${JSON.stringify(w)}: no worktrees dir in the plan`);
    assertUnder(w, plan.worktreesDir, "worktree");
  }
  if (plan.runsLogPath !== resolve(plan.root, v2RunsLog(plan.project)) || plan.runsLogArchivePath !== resolve(plan.root, v2RunsArchive(plan.project))) {
    throw new UnsafePathError("refusing to rewrite a runs log outside the plan's v2 roots");
  }

  for (const d of plan.runDirsToRemove) await rm(d, { recursive: true, force: true });
  for (const f of plan.sessionLeftoversToRemove) await rm(f, { force: true });
  for (const w of plan.worktreesToRemove) await rm(w, { recursive: true, force: true });

  const summary: ResetSummary = {
    recordsArchived: 0,
    archivePath: plan.runsLogArchivePath,
    runsLogDeleted: false,
    runDirsDeleted: plan.runDirsToRemove,
    sessionLeftoversDeleted: plan.sessionLeftoversToRemove,
    worktreesDeleted: plan.worktreesToRemove,
  };

  const lines = plan.runsLogExists ? await readLines(plan.runsLogPath) : null;
  if (lines === null) return summary;
  const archived = lines.filter((l) => lineMatches(l, plan.ticketKey, plan.role));
  const kept = lines.filter((l) => !lineMatches(l, plan.ticketKey, plan.role));
  if (archived.length === 0) return summary;
  await appendFile(plan.runsLogArchivePath, `${archived.join("\n")}\n`, "utf8");
  summary.recordsArchived = archived.length;
  if (plan.wholeProject && kept.length === 0) {
    await rm(plan.runsLogPath, { force: true });
    summary.runsLogDeleted = true;
  } else {
    const tmp = `${plan.runsLogPath}.tmp-${process.pid}`;
    await writeFile(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
    await rename(tmp, plan.runsLogPath);
  }
  return summary;
}

/** Human-readable plan, for --dry-run and before a real run. */
export function describeResetPlan(plan: ResetPlan): string {
  const lines: string[] = [];
  lines.push(`- scope: ${plan.wholeProject ? "WHOLE PROJECT" : `ticket ${plan.ticketKey}`}, role: ${plan.role}`);
  lines.push(
    plan.recordsToArchive > 0
      ? `- archive ${plan.recordsToArchive} record(s) from ${shortenPath(plan.runsLogPath)} to ${shortenPath(plan.runsLogArchivePath)}`
      : `- ${shortenPath(plan.runsLogPath)}: no matching records${plan.runsLogExists ? "" : " (file doesn't exist)"}`,
  );
  lines.push(
    plan.runDirsToRemove.length > 0
      ? `- delete ${plan.runDirsToRemove.length} run dir(s): ${plan.runDirsToRemove.map(shortenPath).join(", ")}`
      : "- .pipeline/v2/<project>/<session>/<ticket>/: no matching run dirs",
  );
  if (plan.wholeProject) {
    lines.push(
      plan.sessionLeftoversToRemove.length > 0
        ? `- prune ${plan.sessionLeftoversToRemove.length} session leftover(s): ${plan.sessionLeftoversToRemove.map(shortenPath).join(", ")}`
        : `- sessions/: no leftovers to prune${plan.role === "all" ? "" : " (only pruned with --role all)"}`,
    );
  } else {
    lines.push(
      plan.worktreesToRemove.length > 0
        ? `- delete ${plan.worktreesToRemove.length} worktree(s): ${plan.worktreesToRemove.map(shortenPath).join(", ")}`
        : "- worktrees: none matching (or no config to find them)",
    );
  }
  if (plan.liveLocks.length > 0) {
    lines.push(
      `- WARNING: session lock(s) present, a worker may be running: ${plan.liveLocks.map(shortenPath).join(", ")}. Stop it first; reset does not.`,
    );
  }
  lines.push("- v1 history (runs/v1/, .pipeline/v1/, runs/<slug>.jsonl, .pipeline/<slug>/, research-loop/) is never touched");
  return lines.join("\n");
}

/** Human-readable summary of what a real run did. */
export function describeResetSummary(summary: ResetSummary): string {
  const lines: string[] = [];
  lines.push(
    summary.recordsArchived > 0
      ? `- ${summary.recordsArchived} record(s) archived to ${shortenPath(summary.archivePath)}${summary.runsLogDeleted ? " (live log deleted, now empty)" : ""}`
      : "- no records archived",
  );
  lines.push(
    summary.runDirsDeleted.length > 0
      ? `- ${summary.runDirsDeleted.length} run dir(s) deleted: ${summary.runDirsDeleted.map(shortenPath).join(", ")}`
      : "- no run dirs deleted",
  );
  if (summary.sessionLeftoversDeleted.length > 0) {
    lines.push(`- ${summary.sessionLeftoversDeleted.length} session leftover(s) deleted`);
  }
  lines.push(
    summary.worktreesDeleted.length > 0
      ? `- ${summary.worktreesDeleted.length} worktree(s) deleted: ${summary.worktreesDeleted.map(shortenPath).join(", ")}`
      : "- no worktrees deleted",
  );
  return lines.join("\n");
}
