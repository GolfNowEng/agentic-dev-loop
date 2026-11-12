import { describe, expect, it, vi } from "vitest";
import { stopOnSignal, trackSession } from "../../src/worker/signal.ts";
import type { Session } from "../../src/core/session.ts";
import { makeSession } from "./helpers.ts";

const FLIGHT = { ticket: "TARS-1", role: "dev" as const, runDir: ".pipeline/v2/repo/dev-1/TARS-1/dev-20261111T110000Z", since: "2026-11-11T11:00:00.000Z" };

describe("trackSession (SIGINT/SIGTERM)", () => {
  it("mid-phase: keeps the lock and marks the in-flight run interrupted", async () => {
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    await t.session.setInFlight(FLIGHT);

    expect(await t.onSignal()).toBe("marked-interrupted");
    expect(fake.current).toEqual({ ...FLIGHT, interrupted: true });
    expect(fake.release).not.toHaveBeenCalled();
  });

  it("between phases: releases the lock", async () => {
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    await t.session.setInFlight(FLIGHT);
    await t.session.setInFlight(null);

    expect(await t.onSignal()).toBe("released");
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("a failed mark never throws (the flight stays a crash)", async () => {
    const fake = makeSession("dev-1", null, [], (f) => f?.interrupted === true);
    const logError = vi.fn();
    const t = trackSession(fake as unknown as Session, logError);
    await t.session.setInFlight(FLIGHT);

    expect(await t.onSignal()).toBe("marked-interrupted");
    expect(fake.current).toEqual(FLIGHT);
    expect(logError).toHaveBeenCalledWith(expect.stringMatching(/interrupted/));
  });
});

describe("stopOnSignal (final review I5)", () => {
  it("stops the running child first, then marks the flight interrupted, then exits 143 on SIGTERM", async () => {
    const order: string[] = [];
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    await t.session.setInFlight(FLIGHT);
    fake.setInFlight.mockImplementation(async () => {
      order.push("mark");
    });

    await stopOnSignal("SIGTERM", {
      tracked: t,
      killChild: async () => {
        order.push("kill");
        return "killed";
      },
      exit: (code) => {
        order.push(`exit ${code}`);
      },
    });

    expect(order).toEqual(["kill", "mark", "exit 143"]);
  });

  it("exits 130 on SIGINT, and still exits when stopping the child throws", async () => {
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    const exit = vi.fn();
    const logError = vi.fn();

    await stopOnSignal("SIGINT", {
      tracked: t,
      killChild: async () => {
        throw new Error("boom");
      },
      exit,
      logError,
    });

    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
    expect(logError).toHaveBeenCalledWith(expect.stringMatching(/boom/));
  });
});

describe("trackSession before the adopted flights are recorded", () => {
  it("a signal with an adopted (unrecorded) inFlight keeps the lock untouched: no release, no rewrite", async () => {
    const fake = makeSession("dev-1", FLIGHT);
    const t = trackSession(fake as unknown as Session);

    expect(t.canRelease()).toBe(false);
    expect(await t.onSignal()).toBe("kept-unrecorded");
    expect(fake.release).not.toHaveBeenCalled();
    expect(fake.setInFlight).not.toHaveBeenCalled();
    expect(fake.current).toEqual(FLIGHT);
  });

  it("unrecorded orphans also keep the lock, and are named in the error log", async () => {
    const fake = makeSession("dev-1", null, [{ ...FLIGHT, ticket: "TARS-5" }]);
    const logError = vi.fn();
    const t = trackSession(fake as unknown as Session, logError);

    expect(await t.onSignal()).toBe("kept-unrecorded");
    expect(fake.release).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("TARS-5"));
  });

  it("once the flights are recorded, an idle signal releases", async () => {
    const fake = makeSession("dev-1", FLIGHT);
    const t = trackSession(fake as unknown as Session);
    t.markFlightsRecorded();

    expect(t.canRelease()).toBe(true);
    expect(await t.onSignal()).toBe("released");
    expect(fake.release).toHaveBeenCalledTimes(1);
  });
});

describe("stopping (post-merge fix 3: the cycle freezes once a signal is received)", () => {
  const SETTLED = Symbol("settled");
  const PENDING = Symbol("pending");
  /** Whether `p` settles within a few macrotask turns. */
  const settles = async (p: Promise<unknown>): Promise<typeof SETTLED | typeof PENDING> => {
    const sentinel = new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), 20));
    return Promise.race([p.then(() => SETTLED, () => SETTLED), sentinel]);
  };

  it("after beginStop, the cycle's setInFlight (set or clear) never settles and never calls through", async () => {
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    t.beginStop();

    expect(await settles(t.session.setInFlight(FLIGHT))).toBe(PENDING);
    expect(await settles(t.session.setInFlight(null))).toBe(PENDING);
    expect(fake.setInFlight).not.toHaveBeenCalled();
    expect(t.current()).toBeNull();
  });

  it("after beginStop, canRelease() is false even with no flight", () => {
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    expect(t.canRelease()).toBe(true);

    t.beginStop();

    expect(t.canRelease()).toBe(false);
  });

  it("stopOnSignal calls beginStop before killChild", async () => {
    const order: string[] = [];
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    const beginStop = t.beginStop;
    t.beginStop = () => {
      order.push("beginStop");
      beginStop();
    };

    const done = stopOnSignal("SIGTERM", {
      tracked: t,
      killChild: async () => {
        order.push("kill");
        return "none";
      },
      exit: () => {
        order.push("exit");
      },
    });
    // beginStop is synchronous, before the first await.
    expect(order).toEqual(["beginStop", "kill"]);
    await done;
    expect(order).toEqual(["beginStop", "kill", "exit"]);
  });

  it("a signal that kills a running child: the cycle's clear hangs, the flight stays interrupted, no release", async () => {
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    await t.session.setInFlight(FLIGHT);
    const exit = vi.fn();
    let cycleClear: Promise<void> | null = null;

    await stopOnSignal("SIGTERM", {
      tracked: t,
      killChild: async () => {
        // The killed child's run returns; the cycle (runPhase) clears its flight
        // while stopOnSignal is still awaiting the kill.
        cycleClear = t.session.setInFlight(null);
        return "killed";
      },
      exit,
    });

    expect(cycleClear).not.toBeNull();
    expect(await settles(cycleClear!)).toBe(PENDING);
    expect(fake.current).toEqual({ ...FLIGHT, interrupted: true });
    expect(fake.setInFlight.mock.calls.map((c) => c[0])).toEqual([FLIGHT, { ...FLIGHT, interrupted: true }]);
    expect(fake.release).not.toHaveBeenCalled();
    expect(t.canRelease()).toBe(false);
    expect(exit).toHaveBeenCalledWith(143);
  });
});

describe("stopping with a lock write already in flight (fix 3 round 1, I1)", () => {
  /** A promise resolved (or rejected) on demand. */
  const deferred = () => {
    let resolve: () => void = () => {};
    let reject: (e: Error) => void = () => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  /** Whether `p` settles within a few macrotask turns. */
  const settles = async (p: Promise<unknown>): Promise<"settled" | "pending"> => {
    const sentinel = new Promise<"pending">((r) => setTimeout(() => r("pending"), 20));
    return Promise.race([p.then(() => "settled" as const, () => "settled" as const), sentinel]);
  };
  /** The fake's next setInFlight waits for `d` before it lands (or throws). */
  const holdNext = (fake: ReturnType<typeof makeSession>, d: ReturnType<typeof deferred>) =>
    fake.setInFlight.mockImplementationOnce(async (f: typeof FLIGHT | null) => {
      await d.promise;
      fake.current = f;
    });

  it("(i) a clear in flight when the signal arrives: onSignal waits for it and releases; the cycle freezes", async () => {
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    await t.session.setInFlight(FLIGHT);
    const d = deferred();
    holdNext(fake, d);
    const cycleClear = t.session.setInFlight(null);
    const exit = vi.fn();

    const stop = stopOnSignal("SIGTERM", { tracked: t, killChild: async () => "none", exit });
    d.resolve();
    await stop;

    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(fake.current).toBeNull();
    expect(fake.setInFlight.mock.calls.map((c) => c[0])).toEqual([FLIGHT, null]);
    expect(await settles(cycleClear)).toBe("pending");
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("(ii) a set in flight when the signal arrives: the lock ends interrupted, no release; the cycle freezes", async () => {
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    const d = deferred();
    holdNext(fake, d);
    const cycleSet = t.session.setInFlight(FLIGHT);

    const stop = stopOnSignal("SIGINT", { tracked: t, killChild: async () => "none", exit: () => {} });
    d.resolve();
    await stop;

    expect(fake.current).toEqual({ ...FLIGHT, interrupted: true });
    expect(fake.release).not.toHaveBeenCalled();
    expect(await settles(cycleSet)).toBe("pending");
  });

  it("a set in flight that fails: onSignal swallows it and decides from the last landed state; the cycle freezes", async () => {
    const fake = makeSession();
    const t = trackSession(fake as unknown as Session);
    const d = deferred();
    fake.setInFlight.mockImplementationOnce(async () => {
      await d.promise;
    });
    const cycleSet = t.session.setInFlight(FLIGHT);

    const stop = stopOnSignal("SIGTERM", { tracked: t, killChild: async () => "none", exit: () => {} });
    d.reject(new Error("session lock lost"));
    await stop;

    expect(fake.release).toHaveBeenCalledTimes(1);
    expect(await settles(cycleSet)).toBe("pending");
  });
});

describe("isStopping (fix 3 round 1, M1)", () => {
  it("is false until beginStop, then true", () => {
    const t = trackSession(makeSession() as unknown as Session);
    expect(t.isStopping()).toBe(false);
    t.beginStop();
    expect(t.isStopping()).toBe(true);
  });
});
