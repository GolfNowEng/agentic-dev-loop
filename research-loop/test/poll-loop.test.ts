import { describe, expect, it } from "vitest";
import { decideNextAction } from "../src/poll-loop.ts";
import type { LoopConfig } from "../src/types.ts";

function makeLoopConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    pollIntervalSec: 60,
    postRunDelaySec: 5,
    ...overrides,
  };
}

describe("decideNextAction", () => {
  it("empty-queue: sleeps for pollIntervalSec when not running once-only", () => {
    const action = decideNextAction("empty-queue", makeLoopConfig(), false);
    expect(action).toEqual({ kind: "sleep", ms: 60_000 });
  });

  it("empty-queue: exits when running once-only", () => {
    const action = decideNextAction("empty-queue", makeLoopConfig(), true);
    expect(action).toEqual({ kind: "exit" });
  });

  it("processed: sleeps for postRunDelaySec, not zero -- this is the fix ported from dev-loop's own postRunDelaySec fix (CHANGELOG 2026-09-02), for the same race: an immediate re-poll can still match a ticket whose status was just transitioned, before Jira's search index catches up", () => {
    const action = decideNextAction("processed", makeLoopConfig({ postRunDelaySec: 5 }), false);
    expect(action).toEqual({ kind: "sleep", ms: 5_000 });
  });

  it("processed: exits when running once-only, without sleeping first", () => {
    const action = decideNextAction("processed", makeLoopConfig(), true);
    expect(action).toEqual({ kind: "exit" });
  });

  it("claim-raced: continues immediately, no sleep -- a claim race should retry right away, not wait", () => {
    const action = decideNextAction("claim-raced", makeLoopConfig(), false);
    expect(action).toEqual({ kind: "continue" });
  });

  it("claim-raced: exits when running once-only", () => {
    const action = decideNextAction("claim-raced", makeLoopConfig(), true);
    expect(action).toEqual({ kind: "exit" });
  });

  it("paused-ceiling: always exits, regardless of once", () => {
    expect(decideNextAction("paused-ceiling", makeLoopConfig(), false)).toEqual({ kind: "exit" });
    expect(decideNextAction("paused-ceiling", makeLoopConfig(), true)).toEqual({ kind: "exit" });
  });

  it("claim-error: sleeps for pollIntervalSec, not continue -- a claim() that threw (e.g. a Jira transition screen's required field) is persistent, not a resolving race, so retrying immediately would hot-loop on the same broken ticket every iteration", () => {
    const action = decideNextAction("claim-error", makeLoopConfig({ pollIntervalSec: 60 }), false);
    expect(action).toEqual({ kind: "sleep", ms: 60_000 });
  });

  it("claim-error: exits when running once-only", () => {
    const action = decideNextAction("claim-error", makeLoopConfig(), true);
    expect(action).toEqual({ kind: "exit" });
  });
});
