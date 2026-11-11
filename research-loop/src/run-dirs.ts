/**
 * Discovers a skill's own self-generated RUN_DIR under
 * `.pipeline/<slug>/runs/`, without main.ts ever controlling or predicting
 * RUN_ID (a UTC timestamp the skill generates internally). The approach:
 * snapshot the directory's entries for a ticket immediately before
 * spawning the skill, snapshot again after it exits, and diff -- whichever
 * `<TICKET>-<RUN_ID>` entry is new is this run's RUN_DIR.
 */

import { readdir } from "node:fs/promises";

/**
 * List the run-directory names under `baseDir` that belong to `ticketKey`
 * (i.e. start with `<ticketKey>-`). Returns an empty set if `baseDir`
 * doesn't exist yet (no runs have ever been logged for this project).
 */
export async function snapshotRunDirs(
  baseDir: string,
  ticketKey: string,
): Promise<Set<string>> {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return new Set();
  }
  const prefix = `${ticketKey}-`;
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name),
  );
}

/**
 * Diff a fresh snapshot against `before` and return the lexicographically
 * newest directory name that appeared since -- RUN_ID's
 * `YYYYMMDDTHHMMSSZ` format sorts chronologically, so this is also the
 * most recent run. Returns null if no new directory appeared (e.g. the
 * skill errored out before creating RUN_DIR).
 */
export async function findNewestRunDir(
  baseDir: string,
  ticketKey: string,
  before: Set<string>,
): Promise<string | null> {
  const after = await snapshotRunDirs(baseDir, ticketKey);
  const added = [...after].filter((name) => !before.has(name));
  if (added.length === 0) return null;
  return added.sort().at(-1)!;
}
