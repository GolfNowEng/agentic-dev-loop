// Deterministic "start fresh" reset of this repo's own v2 pipeline state for
// one project (and optionally one ticket, and one role). Scope:
//   - runs/v2/<project>.jsonl records: archived to
//     runs/v2/<project>.reset-archive.jsonl (append-only), never just deleted;
//   - `<role>-<RUN_ID>` run dirs under .pipeline/v2/<project>/<session>/<ticket>/,
//     in every session;
//   - per-ticket only: leftover pipeline worktrees for the ticket (isPipelineWorktree);
//   - the inFlight entry of a dead session lock (`*.lock` or unadopted
//     `*.lock.stale-*`) naming a matching ticket and role: set to null, pid and
//     start time kept, so the next worker start doesn't adopt and "resume" a run
//     whose dir this reset just deleted;
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

import { appendFile, lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import type { Config, Role } from "./types.ts";
import { isProcessAlive } from "./session.ts";
import { isPipelineWorktree, resolveRepoPath, RUN_ID, SESSION_ID, TICKET_KEY, UnsafePathError, v2CloneDir, v2ProjectDir, v2RunsArchive, v2RunsLog, v2SessionsDir } from "./paths.ts";

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
  /** Role-scoped only: also archive records whose OTHER role has a landed phase. Default false. */
  includeCrossRole?: boolean;
  /** Let executeReset proceed while a live worker holds a session lock. Default false. */
  ignoreLiveWorker?: boolean;
  /** Liveness of a lock holder (pid + start time, epoch s); defaults to session.ts's isProcessAlive. */
  isAlive?: (pid: number, started: number) => boolean;
  /** Leave worktrees to another step: the plan lists none and has no worktrees dir (so nothing is deleted or pruned). Default false. */
  skipWorktrees?: boolean;
}

/** A matching record a role-scoped reset leaves in place (the other role landed in it). */
export interface RefusedRecord {
  ticket: string;
  /** "other role landed: <role> <pr|outcome>" */
  reason: string;
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
  /** Dead session locks whose inFlight names a matching ticket and role: executeReset nulls it. */
  flightsToClear: string[];
  /** The subset of liveLocks whose holder process is alive: executeReset refuses unless ignoreLiveWorker. */
  liveWorkerLocks: string[];
  ignoreLiveWorker: boolean;
  includeCrossRole: boolean;
  /** Role-scoped resets: matching records kept because the other role landed in them. */
  refusedRecords: RefusedRecord[];
  /** Things skipped for safety (e.g. symlinks), printed as WARNING lines. */
  warnings: string[];
}

export interface ResetSummary {
  recordsArchived: number;
  archivePath: string;
  runsLogDeleted: boolean;
  runDirsDeleted: string[];
  sessionLeftoversDeleted: string[];
  worktreesDeleted: string[];
  flightsCleared: string[];
  /** `git worktree prune` ran in the worktrees' repo after deleting them (false: none deleted, or no git repo there). */
  worktreesPruned: boolean;
}

/** Display only: ~/... for paths under the home directory. */
export function shortenPath(path: string): string {
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

/** lstat-based: never follows a symlink. */
async function kind(p: string): Promise<"dir" | "symlink" | "other" | null> {
  try {
    const st = await lstat(p);
    return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

const RUN_DIR_NAME = /^(research|dev)-(.+)$/;

function runDirMatches(name: string, role: ResetRole): boolean {
  const m = RUN_DIR_NAME.exec(name);
  return m !== null && RUN_ID.test(m[2]) && (role === "all" || m[1] === role);
}

const LEFTOVER = [/\.lock\.adopted-/, /^\.acquire\.stale-/, /^\.acquire\.reclaim-/, /^\.acquire\.release-/, /^\.tmp-/];
const isLeftover = (name: string) => LEFTOVER.some((re) => re.test(name));
const isLock = (name: string) => name.endsWith(".lock") && !name.startsWith(".");
/** A lock a worker start may adopt an inFlight from: a lock, or an unadopted stale one. */
const mayHoldFlight = (name: string) => !name.startsWith(".") && (name.endsWith(".lock") || name.includes(".lock.stale-"));

/** True when the lock's holder is dead and its inFlight names `ticket` (any, when null) and `role`. */
function staleFlight(raw: string, ticket: string | null, role: ResetRole, isAlive: (pid: number, started: number) => boolean): boolean {
  if (liveHolder(raw, isAlive)) return false;
  try {
    const f = (JSON.parse(raw) as { inFlight?: { ticket?: unknown; role?: unknown } | null }).inFlight;
    if (!f || typeof f !== "object") return false;
    return (ticket === null || f.ticket === ticket) && (role === "all" || f.role === role);
  } catch {
    return false;
  }
}

type Phaseish = { role?: unknown; outcome?: unknown; pr?: unknown };

/**
 * Classify a log line for this reset: "archive", "skip" (not in scope), or
 * a refusal reason (role-scoped: in scope, but the other role landed in it,
 * so archiving it would drop that landed phase -- e.g. a dev PR the landed
 * guard and reconcile rely on -- unless includeCrossRole).
 * Unreadable lines only go with a whole-project role-all reset.
 */
function classify(line: string, ticket: string | null, role: ResetRole, includeCrossRole: boolean): "archive" | "skip" | RefusedRecord {
  let r: { ticket?: unknown; phases?: unknown; resume?: unknown } | null;
  try {
    r = JSON.parse(line);
  } catch {
    return ticket === null && role === "all" ? "archive" : "skip";
  }
  if (!r || typeof r !== "object") return ticket === null && role === "all" ? "archive" : "skip";
  if (ticket !== null && r.ticket !== ticket) return "skip";
  if (role === "all") return "archive";
  const phases = Array.isArray(r.phases) ? (r.phases as Phaseish[]) : [];
  if (!(phases.some((p) => p?.role === role) || r.resume === role)) return "skip";
  if (includeCrossRole) return "archive";
  const other = phases.find((p) => p && p.role !== role && (p.role === "research" || p.role === "dev") && p.outcome === "landed");
  if (!other) return "archive";
  const what = typeof other.pr === "string" && other.pr ? other.pr : "landed";
  return { ticket: typeof r.ticket === "string" ? r.ticket : "?", reason: `other role landed: ${other.role} ${what}` };
}

function liveHolder(raw: string, isAlive: (pid: number, started: number) => boolean): boolean {
  try {
    const b = JSON.parse(raw) as { pid?: unknown; started?: unknown };
    const ok = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
    return ok(b.pid) && ok(b.started) && isAlive(b.pid, b.started);
  } catch {
    return false;
  }
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
  const includeCrossRole = opts.includeCrossRole ?? false;
  const classes = (lines ?? []).map((l) => classify(l, ticket, role, includeCrossRole));
  const recordsToArchive = classes.filter((c) => c === "archive").length;
  const refusedRecords = classes.filter((c): c is RefusedRecord => typeof c === "object");
  const warnings: string[] = [];

  const projectDir = at(v2ProjectDir(opts.project));
  const sessionsDir = at(v2SessionsDir(opts.project));
  const cloneDir = at(v2CloneDir(opts.project));
  const runDirsToRemove: string[] = [];
  /** A dir we may descend into; a symlink is skipped with a warning so rm never leaves .pipeline/v2/<project>/. */
  const safeDir = async (p: string): Promise<boolean> => {
    const k = await kind(p);
    if (k === "symlink") warnings.push(`skipped symlink ${p} (never followed)`);
    return k === "dir";
  };
  const projectEntries = (await safeDir(projectDir)) ? await list(projectDir) : [];
  for (const s of projectEntries) {
    const sDir = join(projectDir, s);
    if (!SESSION_ID.test(s) || sDir === sessionsDir || sDir === cloneDir || !(await safeDir(sDir))) continue;
    for (const t of ticket !== null ? [ticket] : await list(sDir)) {
      if (!TICKET_KEY.test(t)) continue;
      const tDir = join(sDir, t);
      if (!(await safeDir(tDir))) continue;
      for (const name of await list(tDir)) {
        if (runDirMatches(name, role) && (await safeDir(join(tDir, name)))) runDirsToRemove.push(join(tDir, name));
      }
    }
  }
  runDirsToRemove.sort();

  const sessionFiles = await list(sessionsDir);
  const sessionLeftoversToRemove =
    ticket === null && role === "all" ? sessionFiles.filter(isLeftover).map((f) => join(sessionsDir, f)) : [];
  const liveLocks = sessionFiles.filter(isLock).map((f) => join(sessionsDir, f));
  const isAlive = opts.isAlive ?? ((pid: number, started: number) => isProcessAlive(pid, started));
  const liveWorkerLocks: string[] = [];
  for (const l of liveLocks) {
    if ((await kind(l)) !== "other") continue;
    const raw = await readFile(l, "utf8").catch(() => "");
    if (liveHolder(raw, isAlive)) liveWorkerLocks.push(l);
  }
  const flightsToClear: string[] = [];
  for (const f of sessionFiles.filter(mayHoldFlight)) {
    const l = join(sessionsDir, f);
    if ((await kind(l)) !== "other") continue;
    if (staleFlight(await readFile(l, "utf8").catch(() => ""), ticket, role, isAlive)) flightsToClear.push(l);
  }

  let worktreesDir: string | null = null;
  let worktreesToRemove: string[] = [];
  if (ticket !== null && !opts.skipWorktrees) {
    const base = opts.config?.targetRepo.path ?? (opts.config ? cloneDir : null);
    if (base) {
      worktreesDir = join(base, ".claude", "worktrees");
      worktreesToRemove = (await list(worktreesDir))
        // Only the pipeline's own run worktrees; a person's `<TICKET>-okta-spike` is never removed.
        .filter((n) => isPipelineWorktree(ticket, n))
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
    liveWorkerLocks,
    flightsToClear,
    ignoreLiveWorker: opts.ignoreLiveWorker ?? false,
    includeCrossRole,
    refusedRecords,
    warnings,
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
  if (plan.liveWorkerLocks.length > 0 && !plan.ignoreLiveWorker) {
    throw new Error(
      `refusing to reset: a live worker holds ${plan.liveWorkerLocks.join(", ")}. Stop it first, or pass --ignore-live-worker.`,
    );
  }
  const projectDir = resolve(plan.root, v2ProjectDir(plan.project));
  const sessionsDir = resolve(plan.root, v2SessionsDir(plan.project));
  for (const d of plan.runDirsToRemove) assertUnder(d, projectDir, "run dir");
  for (const f of plan.sessionLeftoversToRemove) assertUnder(f, sessionsDir, "session leftover");
  for (const f of plan.flightsToClear) assertUnder(f, sessionsDir, "session lock");
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
  // rm leaves git's worktree entry behind ("branch is checked out at <deleted dir>"): prune it.
  let worktreesPruned = false;
  if (plan.worktreesToRemove.length > 0 && plan.worktreesDir) {
    try {
      execFileSync("git", ["-C", dirname(dirname(plan.worktreesDir)), "worktree", "prune"], { stdio: "ignore" });
      worktreesPruned = true;
    } catch {
      // Not a git repo (or no git): nothing registered to prune.
    }
  }
  const flightsCleared: string[] = [];
  for (const f of plan.flightsToClear) {
    // Re-read and re-check liveness: a worker may have started since the plan (it would rename
    // this lock away, or write a live one at the same path). Rewritten via temp file + rename.
    const raw = await readFile(f, "utf8").catch(() => "");
    if (!staleFlight(raw, plan.ticketKey, plan.role, isProcessAlive)) continue;
    const tmp = join(sessionsDir, `.tmp-reset-${process.pid}`);
    await writeFile(tmp, JSON.stringify({ ...JSON.parse(raw), inFlight: null }), "utf8");
    await rename(tmp, f);
    flightsCleared.push(f);
  }

  const summary: ResetSummary = {
    recordsArchived: 0,
    archivePath: plan.runsLogArchivePath,
    runsLogDeleted: false,
    runDirsDeleted: plan.runDirsToRemove,
    sessionLeftoversDeleted: plan.sessionLeftoversToRemove,
    worktreesDeleted: plan.worktreesToRemove,
    flightsCleared,
    worktreesPruned,
  };

  const lines = plan.runsLogExists ? await readLines(plan.runsLogPath) : null;
  if (lines === null) return summary;
  const archive = (l: string) => classify(l, plan.ticketKey, plan.role, plan.includeCrossRole) === "archive";
  const archived = lines.filter(archive);
  const kept = lines.filter((l) => !archive(l));
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
  if (plan.flightsToClear.length > 0) {
    lines.push(
      `- clear the in-flight ${plan.ticketKey ?? "matching"}${plan.role === "all" ? "" : ` ${plan.role}`} run recorded in ${plan.flightsToClear.length} dead session lock(s): ${plan.flightsToClear.map(shortenPath).join(", ")}`,
    );
  }
  for (const r of plan.refusedRecords) {
    lines.push(`- REFUSED (${r.reason}): a ${r.ticket} record stays in the live log; --include-cross-role archives it`);
  }
  for (const w of plan.warnings) lines.push(`- WARNING: ${w}`);
  if (plan.liveLocks.length > 0) {
    lines.push(
      `- WARNING: session lock(s) present, a worker may be running: ${plan.liveLocks.map(shortenPath).join(", ")}. Stop it first; reset does not.` +
        (plan.liveWorkerLocks.length > 0 && !plan.ignoreLiveWorker ? " A real run refuses while the holder is alive (--ignore-live-worker overrides)." : ""),
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
  if (summary.flightsCleared.length > 0) {
    lines.push(`- ${summary.flightsCleared.length} stale in-flight run(s) cleared from dead session lock(s)`);
  }
  lines.push(
    summary.worktreesDeleted.length > 0
      ? `- ${summary.worktreesDeleted.length} worktree(s) deleted: ${summary.worktreesDeleted.map(shortenPath).join(", ")}${summary.worktreesPruned ? " (git worktree prune run)" : ""}`
      : "- no worktrees deleted",
  );
  return lines.join("\n");
}
