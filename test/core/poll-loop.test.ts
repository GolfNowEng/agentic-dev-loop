import { describe, expect, it } from "vitest";
import { decideNextAction } from "../../src/core/poll-loop.ts";
import type { LoopConfig } from "../../src/core/types.ts";

function makeLoopConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    pollIntervalSec: 60,
    postRunDelaySec: 5,
    ...overrides,
  };
}

describe("decideNextAction", () => {
  it("idle: sleeps for pollIntervalSec when not running once-only", () => {
    const action = decideNextAction("idle", makeLoopConfig(), false);
    expect(action).toEqual({ kind: "sleep", ms: 60_000 });
  });

  it("idle: exits when running once-only", () => {
    const action = decideNextAction("idle", makeLoopConfig(), true);
    expect(action).toEqual({ kind: "exit" });
  });

  it("ran: sleeps for postRunDelaySec, not zero -- this is the fix for the race where an immediate re-poll can still match a ticket whose status was just transitioned, before Jira's search index catches up (confirmed cause of a duplicate run landing ~2s after TARS-1389/1390/1393 each landed)", () => {
    const action = decideNextAction("ran", makeLoopConfig({ postRunDelaySec: 5 }), false);
    expect(action).toEqual({ kind: "sleep", ms: 5_000 });
  });

  it("ran: exits when running once-only, without sleeping first", () => {
    const action = decideNextAction("ran", makeLoopConfig(), true);
    expect(action).toEqual({ kind: "exit" });
  });

  it("skipped-race: continues immediately, no sleep -- a claim race should retry right away, not wait", () => {
    const action = decideNextAction("skipped-race", makeLoopConfig(), false);
    expect(action).toEqual({ kind: "continue" });
  });

  it("skipped-race: exits when running once-only", () => {
    const action = decideNextAction("skipped-race", makeLoopConfig(), true);
    expect(action).toEqual({ kind: "exit" });
  });

  it("paused: always exits, regardless of once", () => {
    expect(decideNextAction("paused", makeLoopConfig(), false)).toEqual({ kind: "exit" });
    expect(decideNextAction("paused", makeLoopConfig(), true)).toEqual({ kind: "exit" });
  });

  it("claim-error: sleeps for pollIntervalSec, not continue -- a claim() that threw (e.g. a Jira transition screen's required field) is persistent, not a resolving race, so retrying immediately would hot-loop on the same broken ticket every iteration", () => {
    const action = decideNextAction("claim-error", makeLoopConfig({ pollIntervalSec: 60 }), false);
    expect(action).toEqual({ kind: "sleep", ms: 60_000 });
  });

  it("claim-error: exits when running once-only", () => {
    const action = decideNextAction("claim-error", makeLoopConfig(), true);
    expect(action).toEqual({ kind: "exit" });
  });

  // research-loop's v1 result vocabulary is an exact synonym of dev-loop's.
  it.each([
    ["empty-queue", "idle"],
    ["processed", "ran"],
    ["claim-raced", "skipped-race"],
    ["paused-ceiling", "paused"],
  ] as const)("research kind %s behaves exactly like dev kind %s", (research, dev) => {
    const config = makeLoopConfig({ pollIntervalSec: 60, postRunDelaySec: 5 });
    for (const once of [false, true]) {
      expect(decideNextAction(research, config, once)).toEqual(decideNextAction(dev, config, once));
    }
  });
});
