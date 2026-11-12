// Startup warning for DEVLOOP_ENV_FILE (final-review I4). The npm scripts
// load `--env-file="${DEVLOOP_ENV_FILE:-.env}"`; pointing the variable
// outside the repo keeps the Jira token out of the `claude -p` spawn cwd.
// A `.env` left in the repo root defeats that, so startup warns about it.
// The variable may also name the root .env itself (`.env`, `./.env`, its
// absolute path): that is the default spelled out, so no warning (M4). The
// comparison is on resolved paths; a relative value resolves against the
// caller's cwd, as node's --env-file does.
// Pure: the caller supplies the cwd, the root .env's resolved path and
// whether it exists. The variable's value is never part of the message.

import { resolve } from "node:path";

export const LEFTOVER_ROOT_ENV_WARNING = "a .env is still in the repo root, inside the spawn cwd; move it out or delete it";

export interface EnvFileWarningInput {
  /** process.env.DEVLOOP_ENV_FILE as given. */
  envFileVar: string | undefined;
  /** The cwd the npm script ran node from (relative values resolve here). */
  cwd: string;
  /** Absolute path of the repo root's .env. */
  rootEnvPath: string;
  rootEnvExists: boolean;
}

/** The warning to log, or null. An empty variable counts as unset (sh's `${VAR:-.env}` falls back to `.env`). */
export function envFileWarning({ envFileVar, cwd, rootEnvPath, rootEnvExists }: EnvFileWarningInput): string | null {
  if (envFileVar === undefined || envFileVar === "") return null;
  if (resolve(cwd, envFileVar) === resolve(rootEnvPath)) return null;
  return rootEnvExists ? LEFTOVER_ROOT_ENV_WARNING : null;
}
