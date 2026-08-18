/**
 * Parses a skill's verdict.json into a Verdict. Never throws on bad
 * input -- that is the entire point of this module. A missing file, an
 * empty string, or malformed/unparseable JSON, or JSON that is missing
 * required fields, must all produce a Verdict with outcome "error" and
 * failure_category "agent_error" rather than raise.
 */

import { readFile } from "node:fs/promises";
import type { RunOutcome, PhaseReached, Verdict } from "./types.js";

const VALID_OUTCOMES: RunOutcome[] = ["landed", "bounced", "error", "killed"];
const VALID_PHASES: PhaseReached[] = [
  "intake",
  "plan",
  "red",
  "green",
  "verify",
  "pr",
];

function isValidVerdictShape(value: unknown): value is Verdict {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  if (!VALID_OUTCOMES.includes(v.outcome as RunOutcome)) return false;
  if (!VALID_PHASES.includes(v.phase_reached as PhaseReached)) return false;
  if (v.failure_category !== null && typeof v.failure_category !== "string") {
    return false;
  }
  if (typeof v.detail !== "string") return false;

  return true;
}

/** The fallback Verdict produced for any missing/malformed input. */
export function errorVerdict(detail: string): Verdict {
  return {
    outcome: "error",
    phase_reached: "intake",
    failure_category: "agent_error",
    detail,
  };
}

/**
 * Parse verdict.json content (already read as a string, or undefined if
 * the file was missing) into a Verdict. Malformed/missing input yields
 * outcome "error", failure_category "agent_error", never a thrown error.
 */
export function parseVerdict(raw: string | undefined | null): Verdict {
  if (raw === undefined || raw === null) {
    return errorVerdict("verdict.json was missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorVerdict("verdict.json contained malformed JSON");
  }

  if (!isValidVerdictShape(parsed)) {
    return errorVerdict("verdict.json did not match the expected Verdict shape");
  }

  return parsed;
}

/**
 * Read verdict.json from disk at the given path and parse it, applying
 * the same never-throw contract as parseVerdict: a missing file or read
 * error also yields outcome "error" / failure_category "agent_error".
 */
export async function readVerdict(filePath: string): Promise<Verdict> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorVerdict(`verdict.json could not be read: ${message}`);
  }
  return parseVerdict(raw);
}
