// Appends RunLogLine entries to runs.jsonl. Append-only, single writer:
// this module must never rewrite or reorder existing lines - every call
// adds exactly one line at the end of the file.

import { appendFile, readFile } from "node:fs/promises";
import type { RunLogLine } from "./types.ts";

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

/**
 * True if runs.jsonl already has a "landed" line for `ticketKey`. A missing
 * file means nothing has been logged yet, so false, not an error.
 */
export async function hasLandedRun(filePath: string, ticketKey: string): Promise<boolean> {
  let lines: RunLogLine[];
  try {
    lines = await readRunLog(filePath);
  } catch {
    return false;
  }
  return lines.some((line) => line.ticket === ticketKey && line.outcome === "landed");
}

/**
 * Find the most recent run for this ticket key in runs.jsonl that has a
 * PR URL attached -- "landed" (fully succeeded) or "bounced" (intake
 * found a pre-existing PR already open, nothing new to do; see
 * roles/dev/phase.ts's bounced-with-existing-PR branch). Widened beyond
 * "landed" so reset-project's --close-remote can find and close any open
 * PR for a ticket being torn down, not just one from a run that fully
 * landed -- per this session's decision that a reset should close
 * whatever PR exists, regardless of whether that specific run succeeded.
 * Used by reset-project's remote-close module (both roles: a research
 * runs.jsonl always has `pr: null`, so this returns null there). Moved
 * here from roles/dev/reconcile.ts so core never imports a role module;
 * reconcile and the dev landed-ticket guard use findLandedPrUrl /
 * findLandedTickets instead.
 */
export async function findOpenPrUrl(runsLogPath: string, ticketKey: string): Promise<string | null> {
  let lines: RunLogLine[];
  try {
    lines = await readRunLog(runsLogPath);
  } catch {
    return null;
  }
  const openPrLines = lines.filter(
    (l) => l.ticket === ticketKey && (l.outcome === "landed" || l.outcome === "bounced") && l.pr,
  );
  const last = openPrLines[openPrLines.length - 1];
  return last?.pr ?? null;
}
