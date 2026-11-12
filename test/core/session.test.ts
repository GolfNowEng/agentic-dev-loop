import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireSession,
  autoSessionName,
  isProcessAlive,
  processStartTime,
  parseLstart,
  LiveWorkerError,
  AcquireBusyError,
  mutexClaimName,
  type InFlight,
} from "../../src/core/session.ts";
import { UnsafePathError } from "../../src/core/paths.ts";

const NOW = new Date("2026-11-11T01:02:03Z");
const dead = () => false;
const live = () => true;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-test-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeLock(name: string, body: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, `${name}.lock`), typeof body === "string" ? body : JSON.stringify(body));
}
async function readLock(name: string): Promise<{ pid: number; started: number; inFlight: InFlight | null }> {
  return JSON.parse(await fs.readFile(path.join(dir, `${name}.lock`), "utf8"));
}
function opts(extra: Partial<Parameters<typeof acquireSession>[0]> = {}): Parameters<typeof acquireSession>[0] {
  return { dir, pid: 1001, started: 1001, isAlive: dead, now: NOW, ...extra };
}

const FLIGHT: InFlight = { ticket: "TARS-1", role: "dev", runDir: "/tmp/run", since: "2026-11-11T00:00:00Z" };

describe("acquireSession", () => {
  it("auto-names dev-1 when empty", async () => {
    const s = await acquireSession(opts());
    expect(s.name).toBe("dev-1");
    expect(s.inFlight).toBeNull();
    expect(await readLock("dev-1")).toEqual({ pid: 1001, started: 1001, inFlight: null });
  });

  it("creates dir if missing", async () => {
    const nested = path.join(dir, "a", "sessions");
    const s = await acquireSession(opts({ dir: nested }));
    expect(s.name).toBe("dev-1");
    await expect(fs.stat(path.join(nested, "dev-1.lock"))).resolves.toBeTruthy();
  });

  it("refuses a second live worker on the same project", async () => {
    await writeLock("dev-1", { pid: 500, started: 500, inFlight: null });
    for (const requested of [undefined, "alice"]) {
      const err = await acquireSession(opts({ requested, isAlive: live })).catch((e) => e);
      expect(err).toBeInstanceOf(LiveWorkerError);
      expect(err.liveSession).toBe("dev-1");
      expect(err.pid).toBe(500);
    }
    expect((await readLock("dev-1")).pid).toBe(500);
  });

  it("reclaims a stale lock", async () => {
    await writeLock("dev-1", { pid: 500, started: 500, inFlight: null });
    const s = await acquireSession(opts());
    expect(s.name).toBe("dev-1");
    expect((await readLock("dev-1")).pid).toBe(1001);
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith("dev-1.lock.adopted-"))).toBe(true);
  });

  it("honours --session name", async () => {
    const s = await acquireSession(opts({ requested: "alice" }));
    expect(s.name).toBe("alice");
    expect((await readLock("alice")).pid).toBe(1001);
  });

  it("rejects unsafe names", async () => {
    for (const bad of ["../x", "a/b", "", "-x", "Alice", "a".repeat(33)]) {
      await expect(acquireSession(opts({ requested: bad }))).rejects.toBeInstanceOf(UnsafePathError);
    }
    for (const good of ["a", "x-1", "a".repeat(32)]) {
      const s = await acquireSession(opts({ requested: good }));
      expect(s.name).toBe(good);
      await s.release();
    }
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("release removes the lock", async () => {
    const s = await acquireSession(opts());
    await s.release();
    await expect(fs.stat(path.join(dir, "dev-1.lock"))).rejects.toThrow();
    await expect(s.release()).resolves.toBeUndefined();
  });

  it("release never deletes another process's lock", async () => {
    const s = await acquireSession(opts());
    await writeLock("dev-1", { pid: 2222, started: 2222, inFlight: null });
    await s.release();
    expect((await readLock("dev-1")).pid).toBe(2222);
  });

  it("refuses when a differently-named live lock exists", async () => {
    await writeLock("alice", { pid: 500, started: 500, inFlight: null });
    const err = await acquireSession(opts({ requested: "bob", isAlive: live })).catch((e) => e);
    expect(err).toBeInstanceOf(LiveWorkerError);
    expect(err.liveSession).toBe("alice");
    await expect(fs.stat(path.join(dir, "bob.lock"))).rejects.toThrow();
  });

  it("reused pid is stale", async () => {
    await writeLock("dev-1", { pid: 500, started: 111, inFlight: FLIGHT });
    const seen: Array<[number, number]> = [];
    const s = await acquireSession(
      opts({
        isAlive: (pid, startedAt) => {
          seen.push([pid, startedAt]);
          return startedAt === 222;
        },
      }),
    );
    expect(seen).toContainEqual([500, 111]);
    expect(s.name).toBe("dev-1");
    expect((await readLock("dev-1")).pid).toBe(1001);
  });

  it("two concurrent reclaims: exactly one succeeds", async () => {
    await writeLock("dev-1", { pid: 500, started: 500, inFlight: FLIGHT });
    const isAlive = (pid: number) => pid !== 500;
    const results = await Promise.allSettled([
      acquireSession(opts({ pid: 1001, started: 1001, isAlive })),
      acquireSession(opts({ pid: 1002, started: 1002, isAlive })),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    const winner = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSession>>>).value;
    expect(winner.name).toBe("dev-1");
    expect(winner.inFlight).toEqual(FLIGHT);
    const lock = await readLock("dev-1");
    expect(bad[0].reason).toBeInstanceOf(LiveWorkerError);
    expect(bad[0].reason.liveSession).toBe("dev-1");
    expect(bad[0].reason.pid).toBe(lock.pid);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".lock"))).toEqual(["dev-1.lock"]);
  });

  it("inFlight survives a crash", async () => {
    const first = await acquireSession(opts());
    await first.setInFlight(FLIGHT);
    expect((await readLock("dev-1")).inFlight).toEqual(FLIGHT);
    // crash: drop `first` without release
    const second = await acquireSession(opts({ pid: 1002, started: 1002 }));
    expect(second.name).toBe("dev-1");
    expect(second.inFlight).toEqual(FLIGHT);
    // the resumed inFlight is carried into the new lock until cleared
    expect(await readLock("dev-1")).toEqual({ pid: 1002, started: 1002, inFlight: FLIGHT });
    await second.setInFlight(null);
    expect((await readLock("dev-1")).inFlight).toBeNull();
    expect((await fs.readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("an interrupted flag on inFlight (set on SIGINT/SIGTERM mid-phase) survives the reclaim; a non-boolean one is rejected", async () => {
    const first = await acquireSession(opts());
    await first.setInFlight({ ...FLIGHT, interrupted: true });
    const second = await acquireSession(opts({ pid: 1002, started: 1002 }));
    expect(second.inFlight).toEqual({ ...FLIGHT, interrupted: true });
    await expect(second.setInFlight({ ...FLIGHT, interrupted: "yes" as never })).rejects.toThrow();
  });

  it("setInFlight rejects an invalid record", async () => {
    const s = await acquireSession(opts());
    await expect(s.setInFlight({ ...FLIGHT, ticket: "../x" })).rejects.toThrow();
    await expect(s.setInFlight({ ...FLIGHT, role: "qa" as never })).rejects.toThrow();
    expect((await readLock("dev-1")).inFlight).toBeNull();
  });

  it("corrupt lock JSON is reclaimed with inFlight null and never throws", async () => {
    await writeLock("dev-1", "{not json");
    const s = await acquireSession(opts({ isAlive: live }));
    expect(s.name).toBe("dev-1");
    expect(s.inFlight).toBeNull();
    expect((await readLock("dev-1")).pid).toBe(1001);
  });

  it("lock with invalid inFlight fields is reclaimed with inFlight null", async () => {
    const bads = [
      { ...FLIGHT, ticket: "../../etc" },
      { ...FLIGHT, role: "qa" },
      { ...FLIGHT, runDir: 7 },
      { ...FLIGHT, since: null },
      "TARS-1",
    ];
    for (const inFlight of bads) {
      await writeLock("dev-1", { pid: 500, started: 500, inFlight });
      const s = await acquireSession(opts());
      expect(s.name).toBe("dev-1");
      expect(s.inFlight).toBeNull();
      await s.release();
    }
  });

  it("corrupt lock whose pid is alive still refuses", async () => {
    await writeLock("dev-1", { pid: 500, started: 500, inFlight: { ticket: "bad key" } });
    const err = await acquireSession(opts({ isAlive: live })).catch((e) => e);
    expect(err).toBeInstanceOf(LiveWorkerError);
    expect(err.liveSession).toBe("dev-1");
    expect(err.pid).toBe(500);
  });

  it("auto-name picks the lowest free dev-<n>", async () => {
    // a stale non-dev lock is reclaimed; dev-1 is then free
    await writeLock("alice", { pid: 500, started: 500, inFlight: FLIGHT });
    const s = await acquireSession(opts());
    expect(s.name).toBe("dev-1");
    expect(s.inFlight).toEqual(FLIGHT);
  });
});

describe("autoSessionName", () => {
  it("returns the lowest n >= 1 not taken", () => {
    expect(autoSessionName(new Set())).toBe("dev-1");
    expect(autoSessionName(new Set(["dev-1", "dev-3"]))).toBe("dev-2");
    expect(autoSessionName(new Set(["dev-2"]))).toBe("dev-1");
  });
});

const FLIGHT2: InFlight = { ticket: "TARS-2", role: "research", runDir: "/tmp/run2", since: "2026-11-11T00:00:01Z" };

describe("acquireSession: fix round 1 (mutex, atomic publish, adoption)", () => {
  it("two simultaneous acquires on an empty dir (same auto name): exactly one succeeds", async () => {
    for (let round = 0; round < 5; round++) {
      const d = await fs.mkdtemp(path.join(os.tmpdir(), "session-race-"));
      const isAlive = (pid: number) => pid === 1001 || pid === 1002;
      const results = await Promise.allSettled([
        acquireSession(opts({ dir: d, pid: 1001, started: 1001, isAlive })),
        acquireSession(opts({ dir: d, pid: 1002, started: 1002, isAlive })),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const bad = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(bad.reason).toBeInstanceOf(LiveWorkerError);
      expect(bad.reason.liveSession).toBe("dev-1");
      expect((await fs.readdir(d)).filter((f) => f.endsWith(".lock"))).toEqual(["dev-1.lock"]);
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it("two simultaneous acquires with different requested names: exactly one succeeds", async () => {
    const isAlive = (pid: number) => pid === 1001 || pid === 1002;
    const results = await Promise.allSettled([
      acquireSession(opts({ requested: "alice", pid: 1001, started: 1001, isAlive })),
      acquireSession(opts({ requested: "bob", pid: 1002, started: 1002, isAlive })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const bad = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(bad.reason).toBeInstanceOf(LiveWorkerError);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".lock"))).toHaveLength(1);
  });

  it("a lock is never observable half-written, and a second acquire mid-publish refuses", async () => {
    const isAlive = (pid: number) => pid === 1001 || pid === 1002;
    let second: Promise<unknown> | undefined;
    const first = await acquireSession(
      opts({
        pid: 1001,
        started: 1001,
        isAlive,
        _hooks: {
          beforePublish: async () => {
            // the lock is not visible at all until it is fully written
            await expect(fs.stat(path.join(dir, "dev-1.lock"))).rejects.toThrow();
            second = acquireSession(opts({ pid: 1002, started: 1002, isAlive, mutexTimeoutMs: 100 })).catch((e) => e);
            await new Promise((r) => setTimeout(r, 150));
          },
        },
      }),
    );
    expect(first.name).toBe("dev-1");
    const err = await second;
    expect(err instanceof AcquireBusyError || err instanceof LiveWorkerError).toBe(true);
    expect(await readLock("dev-1")).toEqual({ pid: 1001, started: 1001, inFlight: null });
  });

  it("a live acquire mutex holder blocks, then AcquireBusyError", async () => {
    await fs.writeFile(path.join(dir, ".acquire"), JSON.stringify({ pid: 777, started: 777 }));
    const err = await acquireSession(opts({ isAlive: (p) => p === 777, mutexTimeoutMs: 100 })).catch((e) => e);
    expect(err).toBeInstanceOf(AcquireBusyError);
    expect(err.holderPid).toBe(777);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".lock"))).toEqual([]);
  });

  it("a stale acquire mutex is reclaimed", async () => {
    await fs.writeFile(path.join(dir, ".acquire"), JSON.stringify({ pid: 777, started: 777 }));
    const s = await acquireSession(opts());
    expect(s.name).toBe("dev-1");
    // the mutex is released after acquire
    await expect(fs.stat(path.join(dir, ".acquire"))).rejects.toThrow();
  });

  it("the mutex is released even when acquire refuses", async () => {
    await writeLock("dev-1", { pid: 500, started: 500, inFlight: null });
    await expect(acquireSession(opts({ isAlive: live }))).rejects.toBeInstanceOf(LiveWorkerError);
    await expect(fs.stat(path.join(dir, ".acquire"))).rejects.toThrow();
  });

  it("a .stale file left by a reclaimer that died before publishing is adopted (inFlight not lost)", async () => {
    // reclaimer renamed dev-1.lock away, then died before publishing its own lock
    await fs.writeFile(path.join(dir, "dev-1.lock.stale-20261111T000000Z-900"), JSON.stringify({ pid: 500, started: 500, inFlight: FLIGHT }));
    const s = await acquireSession(opts());
    expect(s.inFlight).toEqual(FLIGHT);
    expect(s.orphanedInFlight).toEqual([]);
    expect(await readLock("dev-1")).toEqual({ pid: 1001, started: 1001, inFlight: FLIGHT });
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.includes(".stale-"))).toBe(false);
    expect(files.some((f) => f.includes(".adopted-"))).toBe(true);
    // not adopted twice
    await s.setInFlight(null);
    await s.release();
    const again = await acquireSession(opts({ pid: 1002, started: 1002 }));
    expect(again.inFlight).toBeNull();
    expect(again.orphanedInFlight).toEqual([]);
  });

  it("several stale inFlights: the chosen name's is adopted, the rest returned as orphanedInFlight", async () => {
    await writeLock("alice", { pid: 500, started: 500, inFlight: FLIGHT2 });
    await writeLock("bob", { pid: 501, started: 501, inFlight: FLIGHT });
    const s = await acquireSession(opts({ requested: "bob" }));
    expect(s.name).toBe("bob");
    expect(s.inFlight).toEqual(FLIGHT);
    expect(s.orphanedInFlight).toEqual([FLIGHT2]);
  });

  it("duplicate inFlight records are not reported twice", async () => {
    await writeLock("dev-1", { pid: 500, started: 500, inFlight: FLIGHT });
    await fs.writeFile(path.join(dir, "dev-1.lock.stale-20261111T000000Z-900"), JSON.stringify({ pid: 400, started: 400, inFlight: FLIGHT }));
    const s = await acquireSession(opts());
    expect(s.inFlight).toEqual(FLIGHT);
    expect(s.orphanedInFlight).toEqual([]);
  });

  it("concurrent reclaim of a stale lock with inFlight: the winner holds it", async () => {
    await writeLock("dev-1", { pid: 500, started: 500, inFlight: FLIGHT });
    const isAlive = (pid: number) => pid === 1001 || pid === 1002;
    const results = await Promise.allSettled([
      acquireSession(opts({ pid: 1001, started: 1001, isAlive })),
      acquireSession(opts({ pid: 1002, started: 1002, isAlive })),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSession>>>[];
    expect(ok).toHaveLength(1);
    expect(ok[0].value.inFlight).toEqual(FLIGHT);
  });
});

describe("acquireSession: fix round 2 (mutex ABA, bounded retry, same-process)", () => {
  function gate() {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  }
  const DEAD_MUTEX = JSON.stringify({ pid: 666, started: 666, nonce: "dead-holder" });

  it("ABA: a reclaimer that observed a stale mutex never removes the fresh one that replaced it", async () => {
    await fs.writeFile(path.join(dir, ".acquire"), DEAD_MUTEX);
    const isAlive = (pid: number) => pid !== 666;
    const aObserved = gate();
    const aGo = gate();
    const aReclaimDone = gate();
    const bAtPublish = gate();
    const bGo = gate();

    // A observes D (dead) and pauses right before its reclaim.
    const A = acquireSession(
      opts({
        pid: 1001,
        started: 1001,
        isAlive,
        _hooks: {
          onStaleMutex: async () => {
            aObserved.open();
            await aGo.p;
          },
          afterStaleMutexReclaim: async () => aReclaimDone.open(),
        },
      }),
    ).catch((e) => e);
    await aObserved.p;

    // B also observes D, reclaims it, takes the mutex, pauses before publishing dev-1.
    const B = acquireSession(
      opts({
        pid: 1002,
        started: 1002,
        isAlive,
        _hooks: {
          beforePublish: async () => {
            bAtPublish.open();
            await bGo.p;
          },
        },
      }),
    ).catch((e) => e);
    await bAtPublish.p;
    const heldByB = JSON.parse(await fs.readFile(path.join(dir, ".acquire"), "utf8"));
    expect(heldByB.pid).toBe(1002);

    // A resumes its (now outdated) reclaim: B's fresh mutex must survive it.
    aGo.open();
    await aReclaimDone.p;
    expect(JSON.parse(await fs.readFile(path.join(dir, ".acquire"), "utf8"))).toEqual(heldByB);

    // A fresh starter C arrives while B still holds the mutex.
    const C = acquireSession(opts({ pid: 1003, started: 1003, isAlive })).catch((e) => e);
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.parse(await fs.readFile(path.join(dir, ".acquire"), "utf8"))).toEqual(heldByB);

    bGo.open();
    const [a, b, c] = await Promise.all([A, B, C]);
    expect(b.name).toBe("dev-1");
    for (const loser of [a, c]) {
      expect(loser).toBeInstanceOf(LiveWorkerError);
      expect(loser.liveSession).toBe("dev-1");
      expect(loser.pid).toBe(1002);
    }
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".lock"))).toEqual(["dev-1.lock"]);
    expect((await readLock("dev-1")).pid).toBe(1002);
    await expect(fs.stat(path.join(dir, ".acquire"))).rejects.toThrow();
  });

  it("the mutex body carries a nonce", async () => {
    let seen: Record<string, unknown> | undefined;
    await acquireSession(
      opts({
        _hooks: {
          beforePublish: async () => {
            seen = JSON.parse(await fs.readFile(path.join(dir, ".acquire"), "utf8"));
          },
        },
      }),
    );
    expect(seen).toMatchObject({ pid: 1001, started: 1001 });
    expect(typeof seen!.nonce).toBe("string");
    expect((seen!.nonce as string).length).toBeGreaterThanOrEqual(16);
  });

  it("releasing never deletes a mutex that is not ours", async () => {
    // B's mutex replaced ours (e.g. a reclaim misjudged us dead): our release must leave it alone.
    const other = JSON.stringify({ pid: 2002, started: 2002, nonce: "someone-else" });
    await acquireSession(
      opts({
        isAlive: (p) => p === 2002,
        _hooks: {
          beforePublish: async () => {
            await fs.writeFile(path.join(dir, ".acquire"), other);
          },
        },
      }),
    ).catch(() => undefined);
    expect(await fs.readFile(path.join(dir, ".acquire"), "utf8")).toBe(other);
  });

  it("bounded retry: a live mutex holder ends in AcquireBusyError on a fake clock", async () => {
    await fs.writeFile(path.join(dir, ".acquire"), JSON.stringify({ pid: 777, started: 777, nonce: "n" }));
    let t = 0;
    const sleeps: number[] = [];
    const clock = { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) };
    const err = await acquireSession(opts({ isAlive: (p) => p === 777, mutexTimeoutMs: 1000, _hooks: { clock } })).catch((e) => e);
    expect(err).toBeInstanceOf(AcquireBusyError);
    expect(err.holderPid).toBe(777);
    expect(t).toBeGreaterThanOrEqual(1000);
    expect(sleeps.length).toBeLessThan(500);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(50);
    expect(Math.min(...sleeps)).toBeGreaterThan(0);
  });

  it("bounded retry: a stale mutex whose reclaim claim is stuck ends in AcquireBusyError (fail closed)", async () => {
    await fs.writeFile(path.join(dir, ".acquire"), DEAD_MUTEX);
    // a reclaimer that crashed mid-reclaim left its claim behind
    await fs.writeFile(path.join(dir, mutexClaimName(DEAD_MUTEX)), JSON.stringify({ pid: 888, started: 888, nonce: "x" }));
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const err = await acquireSession(opts({ mutexTimeoutMs: 500, _hooks: { clock } })).catch((e) => e);
    expect(err).toBeInstanceOf(AcquireBusyError);
    expect(err.message).toContain(mutexClaimName(DEAD_MUTEX));
    expect(t).toBeGreaterThanOrEqual(500);
    expect(await fs.readFile(path.join(dir, ".acquire"), "utf8")).toBe(DEAD_MUTEX);
  });

  it("same-process double acquire refuses, naming our own session, and leaves our lock intact", async () => {
    const isAlive = (p: number) => p === 1001;
    const first = await acquireSession(opts({ isAlive }));
    await first.setInFlight(FLIGHT);
    for (const requested of [undefined, "alice"]) {
      const err = await acquireSession(opts({ requested, isAlive })).catch((e) => e);
      expect(err).toBeInstanceOf(LiveWorkerError);
      expect(err.liveSession).toBe("dev-1");
      expect(err.pid).toBe(1001);
    }
    expect(await readLock("dev-1")).toEqual({ pid: 1001, started: 1001, inFlight: FLIGHT });
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.includes(".stale-") || f.includes(".adopted-"))).toEqual([]);
    expect(files.filter((f) => f.endsWith(".lock"))).toEqual(["dev-1.lock"]);
  });
});

describe("parseLstart", () => {
  it("parses the C-locale ps lstart format as UTC epoch seconds", () => {
    expect(parseLstart("Wed Nov 11 19:03:23 2026")).toBe(Date.UTC(2026, 10, 11, 19, 3, 23) / 1000);
    expect(parseLstart("Mon Jan  5 01:02:03 2026")).toBe(Date.UTC(2026, 0, 5, 1, 2, 3) / 1000);
  });
  it("returns null for anything else", () => {
    for (const s of ["", "Mer 11 nov 11:00:18 2026", "Wed Foo 11 19:03:23 2026", "garbage"]) expect(parseLstart(s)).toBeNull();
  });
});

describe("isProcessAlive / processStartTime", () => {
  it("the current process is alive with its own start time (epoch seconds)", () => {
    const started = processStartTime(process.pid);
    expect(typeof started).toBe("number");
    const expected = Date.now() / 1000 - process.uptime();
    expect(Math.abs(started! - expected)).toBeLessThan(5);
    expect(isProcessAlive(process.pid, started!)).toBe(true);
  });

  it("TZ / LC_ALL differences between capture and compare do not matter", () => {
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    try {
      process.env.TZ = "America/Los_Angeles";
      process.env.LC_ALL = "fr_FR.UTF-8";
      const a = processStartTime(process.pid);
      process.env.TZ = "Asia/Tokyo";
      delete process.env.LC_ALL;
      process.env.LANG = "de_DE.UTF-8";
      expect(processStartTime(process.pid)).toBe(a);
      expect(isProcessAlive(process.pid, a!)).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("a mismatched start time is not alive", () => {
    expect(isProcessAlive(process.pid, 631152000)).toBe(false);
  });

  it("kill says alive but ps is unparseable: treated as alive", () => {
    expect(isProcessAlive(process.pid, 631152000, () => null)).toBe(true);
  });

  it("a dead pid is not alive", () => {
    // pid well above any realistic pid_max on macOS (99998) / Linux default (4194304)
    expect(isProcessAlive(2_000_000_000, 1)).toBe(false);
    expect(processStartTime(2_000_000_000)).toBeNull();
  });

  it("rejects non-positive-integer pids", () => {
    for (const pid of [0, -1, 1.5, NaN]) {
      expect(isProcessAlive(pid, 1)).toBe(false);
      expect(processStartTime(pid)).toBeNull();
    }
  });
});
