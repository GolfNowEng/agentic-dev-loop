import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireSession,
  autoSessionName,
  isProcessAlive,
  processStartTime,
  LiveWorkerError,
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
async function readLock(name: string): Promise<{ pid: number; started: string; inFlight: InFlight | null }> {
  return JSON.parse(await fs.readFile(path.join(dir, `${name}.lock`), "utf8"));
}
function opts(extra: Partial<Parameters<typeof acquireSession>[0]> = {}): Parameters<typeof acquireSession>[0] {
  return { dir, pid: 1001, started: "S-1001", isAlive: dead, now: NOW, ...extra };
}

const FLIGHT: InFlight = { ticket: "TARS-1", role: "dev", runDir: "/tmp/run", since: "2026-11-11T00:00:00Z" };

describe("acquireSession", () => {
  it("auto-names dev-1 when empty", async () => {
    const s = await acquireSession(opts());
    expect(s.name).toBe("dev-1");
    expect(s.inFlight).toBeNull();
    expect(await readLock("dev-1")).toEqual({ pid: 1001, started: "S-1001", inFlight: null });
  });

  it("creates dir if missing", async () => {
    const nested = path.join(dir, "a", "sessions");
    const s = await acquireSession(opts({ dir: nested }));
    expect(s.name).toBe("dev-1");
    await expect(fs.stat(path.join(nested, "dev-1.lock"))).resolves.toBeTruthy();
  });

  it("refuses a second live worker on the same project", async () => {
    await writeLock("dev-1", { pid: 500, started: "S-500", inFlight: null });
    for (const requested of [undefined, "alice"]) {
      const err = await acquireSession(opts({ requested, isAlive: live })).catch((e) => e);
      expect(err).toBeInstanceOf(LiveWorkerError);
      expect(err.liveSession).toBe("dev-1");
      expect(err.pid).toBe(500);
    }
    expect((await readLock("dev-1")).pid).toBe(500);
  });

  it("reclaims a stale lock", async () => {
    await writeLock("dev-1", { pid: 500, started: "S-500", inFlight: null });
    const s = await acquireSession(opts());
    expect(s.name).toBe("dev-1");
    expect((await readLock("dev-1")).pid).toBe(1001);
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith("dev-1.lock.stale-"))).toBe(true);
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
    await writeLock("dev-1", { pid: 2222, started: "S-2222", inFlight: null });
    await s.release();
    expect((await readLock("dev-1")).pid).toBe(2222);
  });

  it("refuses when a differently-named live lock exists", async () => {
    await writeLock("alice", { pid: 500, started: "S-500", inFlight: null });
    const err = await acquireSession(opts({ requested: "bob", isAlive: live })).catch((e) => e);
    expect(err).toBeInstanceOf(LiveWorkerError);
    expect(err.liveSession).toBe("alice");
    await expect(fs.stat(path.join(dir, "bob.lock"))).rejects.toThrow();
  });

  it("reused pid is stale", async () => {
    await writeLock("dev-1", { pid: 500, started: "OLD", inFlight: FLIGHT });
    const seen: Array<[number, string]> = [];
    const s = await acquireSession(
      opts({
        isAlive: (pid, startedAt) => {
          seen.push([pid, startedAt]);
          return startedAt === "NEW";
        },
      }),
    );
    expect(seen).toContainEqual([500, "OLD"]);
    expect(s.name).toBe("dev-1");
    expect((await readLock("dev-1")).pid).toBe(1001);
  });

  it("two concurrent reclaims: exactly one succeeds", async () => {
    await writeLock("dev-1", { pid: 500, started: "S-500", inFlight: FLIGHT });
    const isAlive = (pid: number) => pid !== 500;
    const results = await Promise.allSettled([
      acquireSession(opts({ pid: 1001, started: "S-1001", isAlive })),
      acquireSession(opts({ pid: 1002, started: "S-1002", isAlive })),
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
    const second = await acquireSession(opts({ pid: 1002, started: "S-1002" }));
    expect(second.name).toBe("dev-1");
    expect(second.inFlight).toEqual(FLIGHT);
    // the resumed inFlight is carried into the new lock until cleared
    expect(await readLock("dev-1")).toEqual({ pid: 1002, started: "S-1002", inFlight: FLIGHT });
    await second.setInFlight(null);
    expect((await readLock("dev-1")).inFlight).toBeNull();
    expect((await fs.readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([]);
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
      await writeLock("dev-1", { pid: 500, started: "S-500", inFlight });
      const s = await acquireSession(opts());
      expect(s.name).toBe("dev-1");
      expect(s.inFlight).toBeNull();
      await s.release();
    }
  });

  it("corrupt lock whose pid is alive still refuses", async () => {
    await writeLock("dev-1", { pid: 500, started: "S-500", inFlight: { ticket: "bad key" } });
    const err = await acquireSession(opts({ isAlive: live })).catch((e) => e);
    expect(err).toBeInstanceOf(LiveWorkerError);
    expect(err.liveSession).toBe("dev-1");
    expect(err.pid).toBe(500);
  });

  it("auto-name picks the lowest free dev-<n>", async () => {
    // a stale non-dev lock is reclaimed; dev-1 is then free
    await writeLock("alice", { pid: 500, started: "S-500", inFlight: FLIGHT });
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

describe("isProcessAlive / processStartTime", () => {
  it("the current process is alive with its own start time", () => {
    const started = processStartTime(process.pid);
    expect(typeof started).toBe("string");
    expect(started).not.toBe("");
    expect(isProcessAlive(process.pid, started!)).toBe(true);
  });

  it("a mismatched start time is not alive", () => {
    expect(isProcessAlive(process.pid, "Mon Jan  1 00:00:00 1990")).toBe(false);
  });

  it("a dead pid is not alive", () => {
    // pid well above any realistic pid_max on macOS (99998) / Linux default (4194304)
    expect(isProcessAlive(2_000_000_000, "anything")).toBe(false);
    expect(processStartTime(2_000_000_000)).toBeNull();
  });

  it("rejects non-positive-integer pids", () => {
    for (const pid of [0, -1, 1.5, NaN]) {
      expect(isProcessAlive(pid, "x")).toBe(false);
      expect(processStartTime(pid)).toBeNull();
    }
  });
});
