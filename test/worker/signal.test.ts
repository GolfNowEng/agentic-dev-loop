import { describe, expect, it, vi } from "vitest";
import { trackSession } from "../../src/worker/signal.ts";
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
