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
