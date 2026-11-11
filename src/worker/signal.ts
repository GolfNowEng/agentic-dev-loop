// What the process does with its session on SIGINT/SIGTERM. Mid-phase, the
// lock is kept (the next start resumes the run) and its inFlight is marked
// `interrupted: true`, so recovery does not count a stopped run as a failed
// attempt. Not mid-phase, the lock is released. Pure over the session handle
// so the session fake can test it; main.ts installs it.

import type { InFlight, Session } from "../core/session.ts";

export interface TrackedSession {
  /** The handle the cycle uses: its setInFlight is tracked. */
  session: Session;
  /** The run in flight right now, or null. */
  current: () => InFlight | null;
  /** On a signal: mark the in-flight run interrupted (kept in the lock), or release the lock. Never throws. */
  onSignal: () => Promise<"marked-interrupted" | "released">;
}

export function trackSession(session: Session, logError: (m: string) => void = () => {}): TrackedSession {
  let current: InFlight | null = null;
  return {
    session: {
      ...session,
      setInFlight: async (f) => {
        await session.setInFlight(f);
        current = f;
      },
    },
    current: () => current,
    onSignal: async () => {
      if (current !== null) {
        try {
          await session.setInFlight({ ...current, interrupted: true });
        } catch (err) {
          // The run stays recorded as in flight (a crash): resumed, counted as an attempt.
          logError(`could not mark the in-flight run interrupted: ${err instanceof Error ? err.message : String(err)}`);
        }
        return "marked-interrupted";
      }
      try {
        await session.release();
      } catch (err) {
        logError(`could not release the session lock: ${err instanceof Error ? err.message : String(err)}`);
      }
      return "released";
    },
  };
}
