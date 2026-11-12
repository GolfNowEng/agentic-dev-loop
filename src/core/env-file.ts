// Startup warning for DEVLOOP_ENV_FILE (final-review I4). The npm scripts
// load `--env-file="${DEVLOOP_ENV_FILE:-.env}"`; pointing the variable
// outside the repo keeps the Jira token out of the `claude -p` spawn cwd.
// A `.env` left in the repo root defeats that, so startup warns about it.
// Pure: the caller supplies whether the root .env exists. The variable's
// value is never part of the message.

export const LEFTOVER_ROOT_ENV_WARNING = "a .env is still in the repo root, inside the spawn cwd; move it out or delete it";

/** The warning to log, or null. An empty variable counts as unset (sh's `${VAR:-.env}` falls back to `.env`). */
export function envFileWarning(envFileVar: string | undefined, rootEnvExists: boolean): string | null {
  if (envFileVar === undefined || envFileVar === "") return null;
  return rootEnvExists ? LEFTOVER_ROOT_ENV_WARNING : null;
}
