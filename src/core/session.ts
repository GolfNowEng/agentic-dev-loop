// Worker session identity and lockfile (spec §6.2).
//
// One live worker per project: every `<dir>/*.lock` is scanned and any live
// one refuses the new worker (LiveWorkerError). A lock whose process is gone
// (or whose pid was reused — the start time no longer matches) is stale: it is
// reclaimed by renaming it to `<lock>.stale-<ts>-<pid>` (only the process whose
// rename succeeds proceeds) and its `inFlight` record is handed back so the
// worker can resume the crashed run. Corrupt locks never throw; they are
// reclaimed like stale ones with `inFlight: null`.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { SESSION_ID, TICKET_KEY, UnsafePathError, runIdNow } from "./paths.ts";
import type { Role } from "./types.ts";

export interface InFlight {
  ticket: string;
  role: Role;
  runDir: string;
  since: string;
}

interface LockBody {
  pid: number;
  started: string;
  inFlight: InFlight | null;
}

export class LiveWorkerError extends Error {
  readonly liveSession: string;
  readonly pid: number;
  constructor(liveSession: string, pid: number) {
    super(`a live worker already holds session "${liveSession}" (pid ${pid}) for this project`);
    this.name = "LiveWorkerError";
    this.liveSession = liveSession;
    this.pid = pid;
  }
}

export interface AcquireOptions {
  /** The sessions directory (callers pass the resolved v2SessionsDir(slug)). Created if missing. */
  dir: string;
  /** --session <name>; auto-named when omitted. */
  requested?: string;
  pid: number;
  /**
   * Start time recorded in the lock, in the format isAlive compares against.
   * Defaults to processStartTime(pid) (`ps -o lstart=`).
   */
  started?: string;
  isAlive: (pid: number, startedAt: string) => boolean;
  now: Date;
}

export interface Session {
  name: string;
  inFlight: InFlight | null;
  setInFlight: (f: InFlight | null) => Promise<void>;
  release: () => Promise<void>;
}

const LOCK_EXT = ".lock";
const ROLES: readonly string[] = ["research", "dev"] satisfies readonly Role[];

// ---- liveness -------------------------------------------------------------

function isPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

/** `ps -o lstart= -p <pid>`, trimmed; null if the process doesn't exist or ps fails. */
export function processStartTime(pid: number): string | null {
  if (!isPid(pid)) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** The real isAlive: the pid exists (EPERM counts as alive) AND its start time equals `startedAt`. */
export function isProcessAlive(pid: number, startedAt: string): boolean {
  if (!isPid(pid)) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return processStartTime(pid) === startedAt;
}

// ---- naming ---------------------------------------------------------------

/** Auto session name: `dev-<n>` with the lowest n >= 1 not in `taken`. Swap this to change the naming scheme. */
export function autoSessionName(taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const name = `dev-${n}`;
    if (!taken.has(name)) return name;
  }
}

function checkName(name: string): string {
  if (typeof name !== "string" || !SESSION_ID.test(name)) {
    throw new UnsafePathError(`session ${JSON.stringify(name)} must match ${SESSION_ID}`);
  }
  return name;
}

// ---- lock parsing ---------------------------------------------------------

function validInFlight(v: unknown): v is InFlight {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.ticket === "string" &&
    TICKET_KEY.test(f.ticket) &&
    typeof f.role === "string" &&
    ROLES.includes(f.role) &&
    typeof f.runDir === "string" &&
    typeof f.since === "string"
  );
}

interface ScannedLock {
  name: string;
  path: string;
  /** null when the pid could not be parsed (corrupt lock). */
  pid: number | null;
  started: string;
  /** null when absent or when the lock is corrupt. */
  inFlight: InFlight | null;
}

function parseLock(name: string, path: string, raw: string): ScannedLock {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { name, path, pid: null, started: "", inFlight: null };
  }
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const pid = isPid(b.pid) ? b.pid : null;
  const started = typeof b.started === "string" ? b.started : "";
  const wellFormed = pid !== null && typeof b.started === "string" && (b.inFlight === null || validInFlight(b.inFlight));
  return { name, path, pid, started, inFlight: wellFormed && b.inFlight ? (b.inFlight as InFlight) : null };
}

async function scan(dir: string): Promise<ScannedLock[]> {
  const out: ScannedLock[] = [];
  for (const f of (await fs.readdir(dir)).sort()) {
    if (!f.endsWith(LOCK_EXT)) continue;
    const name = f.slice(0, -LOCK_EXT.length);
    const path = join(dir, f);
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // released/reclaimed meanwhile
      throw e;
    }
    out.push(parseLock(name, path, raw));
  }
  return out;
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- acquire --------------------------------------------------------------

export async function acquireSession(opts: AcquireOptions): Promise<Session> {
  const { dir, pid, isAlive, now } = opts;
  if (opts.requested !== undefined) checkName(opts.requested);
  if (!isPid(pid)) throw new Error(`pid ${pid} must be a positive integer`);
  const started = opts.started ?? processStartTime(pid);
  if (started === null) throw new Error(`cannot read the start time of pid ${pid} (ps -o lstart=)`);
  await fs.mkdir(dir, { recursive: true });

  const live = (l: ScannedLock) => l.pid !== null && isAlive(l.pid, l.started);
  const refuseIfLive = (locks: ScannedLock[], except?: string) => {
    const hit = locks.find((l) => l.name !== except && live(l));
    if (hit) throw new LiveWorkerError(hit.name, hit.pid!);
  };

  // inFlight from locks this process reclaimed, kept across the EEXIST rescan.
  let carried: InFlight | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const locks = await scan(dir);
    refuseIfLive(locks);

    // Reclaim every stale lock; only the process whose rename succeeds proceeds.
    const reclaimed: ScannedLock[] = [];
    let lostRace = false;
    for (const l of locks) {
      try {
        await fs.rename(l.path, `${l.path}.stale-${runIdNow(now)}-${pid}`);
        reclaimed.push(l);
      } catch (e) {
        if (errCode(e) !== "ENOENT") throw e;
        lostRace = true;
      }
    }
    if (lostRace) {
      // Another process reclaimed first: wait briefly for its lock and name it.
      for (let i = 0; i < 40; i++) {
        const now2 = await scan(dir);
        refuseIfLive(now2);
        await sleep(25);
      }
      continue; // the other reclaimer never showed up: rescan once
    }

    // Every scanned lock was non-live and is now reclaimed, so no name is taken.
    const name = opts.requested ?? autoSessionName(new Set());
    const resume: InFlight | null =
      reclaimed.find((l) => l.name === name && l.inFlight)?.inFlight ??
      reclaimed.find((l) => l.inFlight)?.inFlight ??
      carried;
    carried = resume;
    const lockPath = join(dir, name + LOCK_EXT);
    const body: LockBody = { pid, started, inFlight: resume };

    let fh: fs.FileHandle;
    try {
      fh = await fs.open(lockPath, "wx");
    } catch (e) {
      if (errCode(e) === "EEXIST") continue; // rescan once
      throw e;
    }
    try {
      await fh.writeFile(JSON.stringify(body) + "\n");
    } finally {
      await fh.close();
    }

    // Post-create check: if another worker slipped in alongside us, back off.
    try {
      refuseIfLive(await scan(dir), name);
    } catch (e) {
      await fs.rm(lockPath, { force: true });
      throw e;
    }

    return makeSession(dir, name, lockPath, pid, started, resume);
  }

  // Two attempts lost a race; report whoever holds a live lock now.
  const final = await scan(dir);
  refuseIfLive(final);
  const holder = final[0];
  throw new LiveWorkerError(holder?.name ?? "unknown", holder?.pid ?? 0);
}

function makeSession(
  dir: string,
  name: string,
  lockPath: string,
  pid: number,
  started: string,
  inFlight: InFlight | null,
): Session {
  const ours = async (): Promise<boolean> => {
    try {
      const l = parseLock(name, lockPath, await fs.readFile(lockPath, "utf8"));
      return l.pid === pid && l.started === started;
    } catch (e) {
      if (errCode(e) === "ENOENT") return false;
      throw e;
    }
  };

  return {
    name,
    inFlight,
    async setInFlight(f) {
      if (f !== null && !validInFlight(f)) throw new Error(`invalid inFlight record ${JSON.stringify(f)}`);
      if (!(await ours())) throw new Error(`session lock ${lockPath} is no longer held by pid ${pid}`);
      const body: LockBody = { pid, started, inFlight: f };
      const tmp = join(dir, `${name}${LOCK_EXT}.tmp-${pid}-${randomBytes(4).toString("hex")}`);
      try {
        await fs.writeFile(tmp, JSON.stringify(body) + "\n", { flag: "wx" });
        await fs.rename(tmp, lockPath);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
    },
    async release() {
      if (await ours()) await fs.rm(lockPath, { force: true });
    },
  };
}
