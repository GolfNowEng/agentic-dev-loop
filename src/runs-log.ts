/**
 * Append-only writer for runs.jsonl. Exactly one JSON line per run.
 * Never rewrites, truncates, or reorders existing lines -- this module
 * must be the single writer, and every write must be a pure append.
 */

import { appendFile, readFile } from "node:fs/promises";
import type { RunLogLine } from "./types.js";

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
