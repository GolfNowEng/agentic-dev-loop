// Pure decision logic for what main.ts's for(;;) poll loop does next, given
// a runLoopIteration() result kind. Pulled out the same way ceilings.ts was
// pulled out of loop-runner.ts, so it's unit-testable without spawning a
// real process -- main.ts itself stays untested wiring.

import type { LoopConfig } from "./types.ts";
import type { LoopIterationAction } from "./loop-runner.ts";

export type PollAction =
  | { kind: "sleep"; ms: number }
  | { kind: "exit" }
  | { kind: "continue" };

/**
 * Decide what the poll loop does after one runLoopIteration() call.
 *
 * "processed" sleeps for `postRunDelaySec`, not zero -- an immediate
 * re-poll can still match a ticket whose status was *just* transitioned
 * (e.g. To Do -> In Progress), because Jira Cloud's search index lags
 * slightly behind a write. This is the same race dev-loop confirmed live
 * (a duplicate ticket-to-pr run landed on TARS-1389/1390/1393 within ~2s
 * of each landing -- see dev-loop's CHANGELOG.md, 2026-09-02) and fixed
 * with its own `postRunDelaySec`; ported here since this loop's `for(;;)`
 * had the identical zero-delay re-poll after a "processed" result.
 *
 * "claim-raced" continues immediately (a claim race should retry right
 * away). "claim-error" sleeps for `pollIntervalSec` instead -- unlike a
 * race (which resolves itself), a claim() throw is a persistent Jira-side
 * error (e.g. a transition's required screen field); retrying immediately
 * would hot-loop on the same broken ticket every iteration. "empty-queue"
 * sleeps for `pollIntervalSec` (unchanged). "paused-ceiling" always exits,
 * regardless of `once`.
 */
export function decideNextAction(
  resultKind: LoopIterationAction,
  loopConfig: LoopConfig,
  once: boolean,
): PollAction {
  if (resultKind === "paused-ceiling") {
    return { kind: "exit" };
  }
  if (once) {
    return { kind: "exit" };
  }
  switch (resultKind) {
    case "empty-queue":
      return { kind: "sleep", ms: loopConfig.pollIntervalSec * 1000 };
    case "processed":
      return { kind: "sleep", ms: loopConfig.postRunDelaySec * 1000 };
    case "claim-raced":
      return { kind: "continue" };
    case "claim-error":
      return { kind: "sleep", ms: loopConfig.pollIntervalSec * 1000 };
  }
}
