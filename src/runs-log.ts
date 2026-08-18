/**
 * Append-only writer for runs.jsonl. Exactly one JSON line per run.
 * Never rewrites, truncates, or reorders existing lines -- this module
 * must be the single writer, and every write must be a pure append.
 */

import { appendFile, readFile } from "node:fs/promises";
import type { RunLogLine } from "./types.ts";

function utcDateKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Append a single RunLogLine to the runs.jsonl file at filePath as one
 * JSON line (no pretty-printing, no trailing content beyond the newline).
 * Creates the file if it does not exist. Must never rewrite prior lines.
 */
export async function appendRunLog(filePath: string, line: RunLogLine): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(line)}\n`, "utf8");
}

/**
 * Read back all lines of runs.jsonl at filePath as parsed RunLogLine
 * objects, in file order. Primarily a test/inspection helper.
 */
export async function readRunLog(filePath: string): Promise<RunLogLine[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunLogLine);
}

/**
 * Count how many runs.jsonl lines have a `started` timestamp on the same
 * UTC calendar day as `now` -- used to feed the maxRunsPerDay ceiling.
 * A missing file (no runs logged yet) counts as zero, not an error.
 */
export async function countRunsToday(filePath: string, now: Date): Promise<number> {
  let lines: RunLogLine[];
  try {
    lines = await readRunLog(filePath);
  } catch {
    return 0;
  }
  const todayKey = now.toISOString().slice(0, 10);
  return lines.filter((line) => utcDateKey(line.started) === todayKey).length;
}
