// Appends RunLogLine entries to runs.jsonl. Append-only, single writer:
// this module must never rewrite or reorder existing lines - every call
// adds exactly one line at the end of the file.

import { appendFile, readFile } from "node:fs/promises";
import type { RunLogLine } from "./types.js";

/**
 * Serialize a RunLogLine to a single JSON line (no trailing newline) and
 * append it plus a newline to the given runs.jsonl file path, creating the
 * file if it does not exist. Must never read/rewrite prior lines.
 */
export async function appendRunLog(
  filePath: string,
  line: RunLogLine,
): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(line)}\n`, "utf8");
}

/**
 * Read back all RunLogLine entries currently in a runs.jsonl file, in
 * file order. Intended for tests/tools to verify what appendRunLog wrote,
 * not used by the hot loop itself.
 */
export async function readRunLog(filePath: string): Promise<RunLogLine[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunLogLine);
}
