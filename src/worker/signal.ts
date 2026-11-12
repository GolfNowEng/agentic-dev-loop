// What the process does with its session on SIGINT/SIGTERM.
//   - Before the adopted flights are recorded in the log (recordAdoptedFlights):
//     the lock is left untouched. Its inFlight is the only durable copy of the
//     adopted run; the next start re-adopts it. Orphans exist only in memory
//     by then (their stale files are already .adopted), so they are named in
//     the error log for a human. main.ts records the flights first thing after
//     acquiring, so this window is one log append.
//   - Mid-phase: the lock is kept and its inFlight marked `interrupted: true`,
//     so recovery does not count the stopped run as a failed attempt.
//   - Otherwise: the lock is released.
// Once a signal is received (`beginStop`, called synchronously first by
// stopOnSignal) the process is stopping and the cycle freezes: the wrapped
// `session.setInFlight` (set or clear) no longer calls through and returns a
// promise that never settles, so the cycle, still running during the
// handler's awaits, makes no further session or log writes (no new flight
// in a released lock, no `error` record for a killed child counted as an
// attempt). onSignal writes through the raw session, so it is unaffected.
// A cycle write already in flight when the signal arrives is awaited by
// onSignal (its error swallowed) before it reads `current`, so it decides
// from the state that landed: a set that landed is marked interrupted, a
// clear that landed is released. That write's caller freezes too once it
// lands (or fails), so the cycle never appends after a write the signal
// overlapped. `canRelease()` is false once stopping: only onSignal decides
// the lock; `isStopping()` lets main.ts's pause path leave the exit to it.
// Pure over the session handle so the session fake can test it; main.ts installs it.

import type { InFlight, Session } from "../core/session.ts";

export type SignalAction = "kept-unrecorded" | "marked-interrupted" | "released";

export interface TrackedSession {
  /** The handle the cycle uses: its setInFlight is tracked. */
  session: Session;
  /** The phase run in flight right now, or null. */
  current: () => InFlight | null;
  /** Call once recordAdoptedFlights has written the adopted flights to the log. */
  markFlightsRecorded: () => void;
  /** True when releasing the lock loses nothing (flights recorded, no phase in flight). */
  canRelease: () => boolean;
  /** Synchronously enter "stopping": freeze the cycle's setInFlight, forbid canRelease. Idempotent. */
  beginStop: () => void;
  /** True once beginStop has been called. */
  isStopping: () => boolean;
  /** On a signal; never throws. */
  onSignal: () => Promise<SignalAction>;
}

export function trackSession(session: Session, logError: (m: string) => void = () => {}): TrackedSession {
  const adopted: InFlight[] = [...(session.inFlight ? [session.inFlight] : []), ...session.orphanedInFlight];
  let recorded = adopted.length === 0;
  let current: InFlight | null = null;
  let stopping = false;
  /** The cycle's setInFlight write in progress, if any; `current` is updated when it lands. */
  let pending: Promise<void> | null = null;
  const freeze = (): Promise<never> => new Promise<never>(() => {});
  const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
  return {
    session: {
      ...session,
      setInFlight: async (f) => {
        if (stopping) return freeze();
        const write = session.setInFlight(f).then(() => {
          current = f;
        });
        pending = write;
        try {
          await write;
        } catch (err) {
          if (stopping) return freeze();
          throw err;
        } finally {
          if (pending === write) pending = null;
        }
        if (stopping) return freeze();
      },
    },
    current: () => current,
    markFlightsRecorded: () => {
      recorded = true;
    },
    canRelease: () => !stopping && recorded && current === null,
    beginStop: () => {
      stopping = true;
    },
    isStopping: () => stopping,
    onSignal: async () => {
      // A cycle write already in flight: let it land (or fail) first, so `current` is the lock's real state.
      if (pending !== null) await pending.catch(() => {});
      if (!recorded) {
        logError(
          `signal before the adopted in-flight runs were recorded; keeping the session lock. ` +
            `Not yet in the log: ${adopted.map((f) => `${f.ticket} (${f.role}, ${f.runDir})`).join(", ")}`,
        );
        return "kept-unrecorded";
      }
      if (current !== null) {
        try {
          await session.setInFlight({ ...current, interrupted: true });
        } catch (err) {
          // The run stays recorded as in flight (a crash): resumed, counted as an attempt.
          logError(`could not mark the in-flight run interrupted: ${msg(err)}`);
        }
        return "marked-interrupted";
      }
      try {
        await session.release();
      } catch (err) {
        logError(`could not release the session lock: ${msg(err)}`);
      }
      return "released";
    },
  };
}

export interface StopOnSignalDeps {
  tracked: TrackedSession;
  /** Stops the running `claude -p` child (spawn-claude's killActiveChild). */
  killChild: () => Promise<unknown>;
  exit: (code: number) => void;
  logError?: (m: string) => void;
}

/**
 * main.ts's SIGINT/SIGTERM handler: enter "stopping" first, synchronously
 * (`beginStop`: the cycle freezes; killChild also refuses new spawns), then
 * stop the running child (SIGTERM,
 * then SIGKILL after the grace), so no orphaned run can still push, then
 * mark/release the session as `onSignal` decides, then exit 130 (SIGINT) or
 * 143. A failure to stop the child is logged and never blocks the exit.
 */
export async function stopOnSignal(sig: NodeJS.Signals, deps: StopOnSignalDeps): Promise<void> {
  deps.tracked.beginStop();
  const logError = deps.logError ?? (() => {});
  try {
    await deps.killChild();
  } catch (err) {
    logError(`could not stop the running claude -p child: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await deps.tracked.onSignal();
  } finally {
    deps.exit(sig === "SIGINT" ? 130 : 143);
  }
}
