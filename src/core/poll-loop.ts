// Pure decision logic for what main.ts's for(;;) poll loop does next, given
// a runLoopIteration() result kind. Pulled out the same way ceilings.ts was
// pulled out of loop-runner.ts, so it's unit-testable without spawning a
// real process -- main.ts itself stays untested wiring.

import type { LoopConfig } from "./types.ts";

export type PollAction =
  | { kind: "sleep"; ms: number }
  | { kind: "exit" }
  | { kind: "continue" };

/**
 * The iteration-result kinds decideNextAction understands. The two v1 loops
 * named the same four outcomes differently, so both vocabularies are
 * accepted (pairs are exact synonyms):
 *
 *   dev-loop        research-loop
 *   "idle"          "empty-queue"
 *   "ran"           "processed"
 *   "skipped-race"  "claim-raced"
 *   "paused"        "paused-ceiling"
 *                   "claim-error"   (research-only: dev-loop has no claim step)
 */
export type PollResultKind =
  | "idle"
  | "empty-queue"
  | "ran"
  | "processed"
  | "skipped-race"
  | "claim-raced"
  | "claim-error"
  | "paused"
  | "paused-ceiling";

/**
 * Decide what the poll loop does after one runLoopIteration() call.
 *
 * "ran"/"processed" sleeps for `postRunDelaySec`, not zero -- an immediate
 * re-poll can still match a ticket whose status was *just* transitioned
 * (e.g. In Progress -> Code Review), because Jira Cloud's search index lags
 * slightly behind a write. Confirmed live: a duplicate ticket-to-pr run
 * landed on TARS-1389/1390/1393 within ~2s of each landing, and for
 * TARS-1389 that duplicate run's own "already landed, nothing to do"
 * bounce raced the real transition and (before the loop-runner.ts fix
 * alongside this one) clobbered its just-set Code Review status back to
 * Blocked. This delay is the other half of that fix -- give Jira's index
 * time to catch up before the next poll can re-match the same ticket.
 *
 * "skipped-race"/"claim-raced" continues immediately (a claim race should
 * retry right away). "claim-error" sleeps for `pollIntervalSec` instead --
 * unlike a race (which resolves itself), a claim() throw is a persistent
 * Jira-side error (e.g. a transition's required screen field); retrying
 * immediately would hot-loop on the same broken ticket every iteration.
 * "idle"/"empty-queue" sleeps for `pollIntervalSec`. "paused"/
 * "paused-ceiling" always exits, regardless of `once`.
 */
export function decideNextAction(
  resultKind: PollResultKind,
  loopConfig: LoopConfig,
  once: boolean,
): PollAction {
  if (resultKind === "paused" || resultKind === "paused-ceiling") {
    return { kind: "exit" };
  }
  if (once) {
    return { kind: "exit" };
  }
  switch (resultKind) {
    case "idle":
    case "empty-queue":
    case "claim-error":
      return { kind: "sleep", ms: loopConfig.pollIntervalSec * 1000 };
    case "ran":
    case "processed":
      return { kind: "sleep", ms: loopConfig.postRunDelaySec * 1000 };
    case "skipped-race":
    case "claim-raced":
      return { kind: "continue" };
  }
}
