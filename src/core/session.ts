// Worker session identity and lockfile (spec §6.2).
//
// One live worker per project. Every acquire runs under a project-wide mutex
// (`<dir>/.acquire`, published atomically with link(2)), so scan → reclaim →
// create → verify never interleaves with another acquire. Inside it:
//   - any live `<dir>/*.lock` refuses the new worker (LiveWorkerError);
//   - every non-live lock (dead pid, reused pid, or corrupt) is renamed to
//     `<name>.lock.stale-<ts>-<pid>-<rand>`;
//   - the inFlight records of every unadopted `.lock.stale-*` file (from this
//     acquire or from a reclaimer that died mid-way) are collected: one is
//     adopted as `inFlight`, any others are returned as `orphanedInFlight`, and
//     the files are renamed to `.lock.adopted-*` only once the new lock is
//     published and verified, so an in-flight ticket is never dropped silently;
//   - the new lock is written to a temp file and link(2)ed into place, so a lock
//     is never observable half-written (a corrupt lock really is corrupt).
//
// Process start times are epoch seconds parsed from `ps -o lstart=` run with
// LC_ALL=C and TZ=UTC, so two starters with different locales/zones agree.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  /** Process start time, epoch seconds (see processStartTime). */
  started: number;
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

/** Another process held the project's acquire mutex for longer than mutexTimeoutMs. */
export class AcquireBusyError extends Error {
  readonly holderPid: number;
  constructor(holderPid: number, waitedMs: number, detail = "") {
    super(
      `another process (pid ${holderPid}) is acquiring a session for this project; gave up after ${waitedMs}ms` +
        (detail ? ` (${detail})` : ""),
    );
    this.name = "AcquireBusyError";
    this.holderPid = holderPid;
  }
}

export interface AcquireOptions {
  /** The sessions directory (callers pass the resolved v2SessionsDir(slug)). Created if missing. */
  dir: string;
  /** --session <name>; auto-named when omitted. */
  requested?: string;
  pid: number;
  /** Start time of `pid`, epoch seconds. Defaults to processStartTime(pid). */
  started?: number;
  /** Liveness of a lock / mutex holder. Production passes isProcessAlive. */
  isAlive: (pid: number, startedAt: number) => boolean;
  now: Date;
  /** How long to wait for a live acquire-mutex holder. Default 5000ms. */
  mutexTimeoutMs?: number;
  /** Test-only seams (not reachable from config). */
  _hooks?: {
    /** Between writing the session lock's temp file and linking it into place. */
    beforePublish?: () => Promise<void>;
    /** After judging the current mutex stale, before claiming its reclaim. */
    onStaleMutex?: () => Promise<void>;
    /** After a stale-mutex reclaim attempt finishes (whether or not it removed anything). */
    afterStaleMutexReclaim?: () => Promise<void>;
    /** Clock for mutex backoff / deadline. */
    clock?: Clock;
  };
}

export interface Session {
  name: string;
  /** The crashed run to resume, if any. */
  inFlight: InFlight | null;
  /** Further in-flight records found in stale locks beyond the adopted one. Never dropped silently. */
  orphanedInFlight: InFlight[];
  setInFlight: (f: InFlight | null) => Promise<void>;
  release: () => Promise<void>;
}

const LOCK_EXT = ".lock";
const STALE_MARK = ".lock.stale-";
const ADOPTED_MARK = ".lock.adopted-";
const MUTEX = ".acquire";
const ROLES: readonly string[] = ["research", "dev"] satisfies readonly Role[];

// ---- liveness -------------------------------------------------------------

function isPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function isStarted(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/** Parse C-locale `ps -o lstart=` output ("Wed Nov 11 19:03:23 2026"), read as UTC, to epoch seconds. */
export function parseLstart(s: string): number | null {
  const m = LSTART.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  const ms = Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** Start time of `pid` as epoch seconds (`ps -o lstart=` under LC_ALL=C, TZ=UTC); null if absent/unparseable. */
export function processStartTime(pid: number): number | null {
  if (!isPid(pid)) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    return parseLstart(out);
  } catch {
    return null;
  }
}

/**
 * The real isAlive: `process.kill(pid, 0)` succeeds (EPERM counts as alive) AND
 * the start time equals `startedAt`. If the pid exists but its start time can't
 * be read, it is treated as ALIVE (fail closed: never reclaim a lock we can't
 * prove is stale).
 */
export function isProcessAlive(
  pid: number,
  startedAt: number,
  startTime: (pid: number) => number | null = processStartTime,
): boolean {
  if (!isPid(pid)) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const actual = startTime(pid);
  return actual === null ? true : actual === startedAt;
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

interface Parsed {
  /** null when the pid could not be parsed (corrupt lock). */
  pid: number | null;
  /** null when absent/invalid. */
  started: number | null;
  /** null when absent or when the lock is corrupt. */
  inFlight: InFlight | null;
}

function parseBody(raw: string): Parsed {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { pid: null, started: null, inFlight: null };
  }
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const pid = isPid(b.pid) ? b.pid : null;
  const started = isStarted(b.started) ? b.started : null;
  const wellFormed = pid !== null && started !== null && (b.inFlight === null || validInFlight(b.inFlight));
  return { pid, started, inFlight: wellFormed && b.inFlight ? (b.inFlight as InFlight) : null };
}

interface FileEntry extends Parsed {
  file: string;
  path: string;
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

async function readEntry(dir: string, file: string): Promise<FileEntry | null> {
  const path = join(dir, file);
  try {
    return { file, path, ...parseBody(await fs.readFile(path, "utf8")) };
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

async function scanFiles(dir: string, keep: (f: string) => boolean): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const f of (await fs.readdir(dir)).sort()) {
    if (!keep(f)) continue;
    const e = await readEntry(dir, f);
    if (e) out.push(e);
  }
  return out;
}

const isLockFile = (f: string) => f.endsWith(LOCK_EXT) && !f.startsWith(".");
const isStaleFile = (f: string) => f.includes(STALE_MARK);
const lockName = (f: string) => f.slice(0, f.indexOf(LOCK_EXT));

const rand = () => randomBytes(4).toString("hex");

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Write `body` fully to a temp file, then link(2) it to `target`. Returns false on EEXIST. */
async function publish(dir: string, target: string, body: unknown, beforeLink?: () => Promise<void>): Promise<boolean> {
  const tmp = join(dir, `.tmp-${process.pid}-${rand()}`);
  try {
    await fs.writeFile(tmp, JSON.stringify(body) + "\n", { flag: "wx" });
    if (beforeLink) await beforeLink();
    await fs.link(tmp, target);
    return true;
  } catch (e) {
    if (errCode(e) === "EEXIST") return false;
    throw e;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// ---- acquire mutex --------------------------------------------------------
//
// `.acquire` holds {pid, started, nonce}; the nonce makes every mutex body
// unique, so a body identifies one specific take of the mutex.
//
// Reclaiming a stale mutex is itself exclusive per body: the reclaimer links a
// claim file named after the stale body's hash (`.acquire.reclaim-<sha>`), then
// re-reads `.acquire` while holding the claim and removes it only if it still
// holds exactly that body. A moved-aside mutex is never restored. Because the
// only processes that may remove body X are (a) X's owner and (b) the single
// holder of X's claim after re-confirming X is present, a reclaimer that judged
// an older body stale can never remove a newer, live one (no ABA). A claim left
// by a reclaimer that crashed mid-reclaim fails closed: AcquireBusyError names
// the file to delete.

interface MutexBody {
  raw: string;
  pid: number | null;
  started: number | null;
  nonce: string | null;
}

async function readMutexFile(path: string): Promise<MutexBody | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
  const p = parseBody(raw);
  let nonce: string | null = null;
  try {
    const b = JSON.parse(raw);
    if (typeof b?.nonce === "string" && b.nonce !== "") nonce = b.nonce;
  } catch {
    // corrupt: nonce stays null
  }
  return { raw, pid: p.pid, started: p.started, nonce };
}

/** File name of the per-body reclaim claim for a stale `.acquire` whose raw content is `raw`. */
export function mutexClaimName(raw: string): string {
  return `${MUTEX}.reclaim-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

interface Mutex {
  stillOurs: () => Promise<boolean>;
  release: () => Promise<void>;
}

async function takeMutex(
  dir: string,
  pid: number,
  started: number,
  isAlive: AcquireOptions["isAlive"],
  timeoutMs: number,
  hooks: AcquireOptions["_hooks"] = {},
): Promise<Mutex> {
  const clock = hooks.clock ?? realClock;
  const path = join(dir, MUTEX);
  const nonce = randomUUID();
  const mine = (b: MutexBody | null) => b !== null && b.pid === pid && b.started === started && b.nonce === nonce;

  const release = async () => {
    if (!mine(await readMutexFile(path))) return; // never touch a mutex that isn't ours
    const aside = join(dir, `${MUTEX}.release-${pid}-${rand()}`);
    try {
      await fs.rename(path, aside);
    } catch (e) {
      if (errCode(e) === "ENOENT") return;
      throw e;
    }
    // Discarded even if it turns out not to be ours (replaced between read and rename):
    // a moved-aside mutex is never restored, so a finished holder can never be resurrected.
    // That body's owner then fails its own verify (stillOurs) and gives up.
    await fs.rm(aside, { force: true });
  };

  const deadline = clock.now() + timeoutMs;
  let holder = 0;
  let detail = "";
  for (let delay = 5; ; delay = Math.min(delay * 2, 50)) {
    if (await publish(dir, path, { pid, started, nonce })) {
      return { stillOurs: async () => mine(await readMutexFile(path)), release };
    }
    const h = await readMutexFile(path);
    if (h !== null) {
      holder = h.pid ?? 0;
      detail = "";
      if (h.pid === null || h.started === null || !isAlive(h.pid, h.started)) {
        await hooks.onStaleMutex?.();
        detail = await reclaimStaleMutex(dir, h.raw, { pid, started, nonce: randomUUID() });
        await hooks.afterStaleMutexReclaim?.();
      }
    }
    if (clock.now() >= deadline) throw new AcquireBusyError(holder, timeoutMs, detail);
    await clock.sleep(Math.max(1, Math.round(delay * (0.5 + Math.random() * 0.5))));
  }
}

/** Remove `.acquire` iff it still holds exactly `staleRaw`. Returns a reason when blocked, "" otherwise. */
async function reclaimStaleMutex(dir: string, staleRaw: string, claimBody: object): Promise<string> {
  const claimFile = mutexClaimName(staleRaw);
  const claim = join(dir, claimFile);
  if (!(await publish(dir, claim, claimBody))) {
    return `stale mutex reclaim is claimed by ${claimFile}; if no acquire is running, delete it`;
  }
  try {
    const now = await readMutexFile(join(dir, MUTEX));
    if (now === null || now.raw !== staleRaw) return ""; // already reclaimed / replaced: nothing to do
    const aside = join(dir, `${MUTEX}.stale-${rand()}`);
    try {
      await fs.rename(join(dir, MUTEX), aside);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    await fs.rm(aside, { force: true }); // discarded, never restored
    return "";
  } finally {
    await fs.rm(claim, { force: true });
  }
}

// ---- acquire --------------------------------------------------------------

function sameFlight(a: InFlight, b: InFlight): boolean {
  return a.ticket === b.ticket && a.role === b.role && a.runDir === b.runDir && a.since === b.since;
}

export async function acquireSession(opts: AcquireOptions): Promise<Session> {
  const { dir, pid, isAlive, now } = opts;
  if (opts.requested !== undefined) checkName(opts.requested);
  if (!isPid(pid)) throw new Error(`pid ${pid} must be a positive integer`);
  const started = opts.started ?? processStartTime(pid);
  if (!isStarted(started)) throw new Error(`cannot read the start time of pid ${pid} (ps -o lstart=)`);
  await fs.mkdir(dir, { recursive: true });

  const mutex = await takeMutex(dir, pid, started, isAlive, opts.mutexTimeoutMs ?? 5000, opts._hooks);
  try {
    const isOurs = (e: Parsed) => e.pid === pid && e.started === started;
    const live = (e: Parsed) => e.pid !== null && isAlive(e.pid, e.started ?? 0);
    // Our own live lock counts too: a second acquire by this process refuses (one worker per project).
    const refuseIfLive = (locks: FileEntry[], except?: string) => {
      const hit = locks.find((l) => l.file !== except && (isOurs(l) || live(l)));
      if (hit) throw new LiveWorkerError(lockName(hit.file), hit.pid!);
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const locks = await scanFiles(dir, isLockFile);
      refuseIfLive(locks);

      // Every lock left is non-live (dead, reused pid, or corrupt): move it aside.
      for (const l of locks) {
        try {
          await fs.rename(l.path, `${l.path}.stale-${runIdNow(now)}-${pid}-${rand()}`);
        } catch (e) {
          if (errCode(e) !== "ENOENT") throw e;
        }
      }

      const name = opts.requested ?? autoSessionName(new Set());
      const stale = await scanFiles(dir, isStaleFile);
      const flights: InFlight[] = [];
      const mine = stale.filter((s) => lockName(s.file) === name);
      for (const s of [...mine, ...stale.filter((s) => !mine.includes(s))]) {
        if (s.inFlight && !flights.some((f) => sameFlight(f, s.inFlight!))) flights.push(s.inFlight);
      }
      const [inFlight = null, ...orphanedInFlight] = flights;

      const lockPath = join(dir, name + LOCK_EXT);
      const body: LockBody = { pid, started, inFlight };
      if (!(await publish(dir, lockPath, body, opts._hooks?.beforePublish))) continue; // rescan once

      // Verify: the lock is ours, nothing else live appeared, and we still hold the mutex.
      const self = await readEntry(dir, name + LOCK_EXT);
      const ok = self !== null && isOurs(self) && (await mutex.stillOurs());
      try {
        if (!ok) throw new Error(`session acquire lost a race on ${lockPath}; retry`);
        refuseIfLive(await scanFiles(dir, isLockFile), name + LOCK_EXT);
      } catch (e) {
        if (self && isOurs(self)) await fs.rm(lockPath, { force: true });
        throw e;
      }

      // Published and verified: the stale records are now owned by this session.
      for (const s of stale) {
        await fs.rename(s.path, s.path.replace(STALE_MARK, ADOPTED_MARK)).catch((e) => {
          if (errCode(e) !== "ENOENT") throw e;
        });
      }
      return makeSession(dir, name, lockPath, pid, started, inFlight, orphanedInFlight);
    }
    throw new Error(`session acquire lost the race in ${dir} twice (lock appeared outside the acquire mutex); retry`);
  } finally {
    await mutex.release();
  }
}

function makeSession(
  dir: string,
  name: string,
  lockPath: string,
  pid: number,
  started: number,
  inFlight: InFlight | null,
  orphanedInFlight: InFlight[],
): Session {
  const ours = async (): Promise<boolean> => {
    const e = await readEntry(dir, name + LOCK_EXT);
    return e !== null && e.pid === pid && e.started === started;
  };

  return {
    name,
    inFlight,
    orphanedInFlight,
    async setInFlight(f) {
      if (f !== null && !validInFlight(f)) throw new Error(`invalid inFlight record ${JSON.stringify(f)}`);
      if (!(await ours())) throw new Error(`session lock ${lockPath} is no longer held by pid ${pid}`);
      const body: LockBody = { pid, started, inFlight: f };
      const tmp = join(dir, `.tmp-${pid}-${rand()}`);
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
