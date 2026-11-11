/**
 * Parses a skill's verdict.json into a Verdict. Never throws on bad
 * input -- that is the entire point of this module. A missing file, an
 * empty string, or malformed/unparseable JSON, or JSON that is missing
 * required fields, must all produce a Verdict with outcome "error" and
 * failure_category "agent_error" rather than raise.
 */

import { readFile } from "node:fs/promises";
import type {
  VerdictOutcome,
  PhaseReached,
  Verdict,
  SizeTrajectory,
  TShirtSize,
  SizeDelta,
} from "./types.ts";

const VALID_OUTCOMES: VerdictOutcome[] = ["landed", "ready", "bounced", "error", "killed"];
const VALID_PHASES: PhaseReached[] = [
  "intake",
  "plan",
  "red",
  "green",
  "verify",
  "pr",
];
const VALID_TSHIRTS: TShirtSize[] = ["S", "M", "L", "XL"];
const VALID_DELTAS: SizeDelta[] = ["grew", "shrank", "unchanged"];

function isValidVerdictShape(value: unknown): value is Verdict {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;

  if (!VALID_OUTCOMES.includes(v.outcome as VerdictOutcome)) return false;
  if (!VALID_PHASES.includes(v.phase_reached as PhaseReached)) return false;
  if (v.failure_category !== null && typeof v.failure_category !== "string") {
    return false;
  }
  if (typeof v.detail !== "string") return false;

  return true;
}

/**
 * Parses a shadow-mode `size_trajectory` value. Fully independent of
 * isValidVerdictShape/parseVerdict -- a malformed trajectory returns null
 * and must never flip a Verdict's `outcome` to "error". Pure telemetry:
 * nothing downstream acts on the parsed value yet (see
 * docs/future-enhancements.md).
 */
export function parseSizeTrajectory(value: unknown): SizeTrajectory | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  if (!VALID_TSHIRTS.includes(v.step4_tshirt as TShirtSize)) return null;
  if (!VALID_DELTAS.includes(v.delta as SizeDelta)) return null;
  if (typeof v.final_score !== "number" || !Number.isFinite(v.final_score)) {
    return null;
  }
  if (v.final_score < 0 || v.final_score > 10) return null;

  return {
    step4_tshirt: v.step4_tshirt as TShirtSize,
    delta: v.delta as SizeDelta,
    final_score: v.final_score,
  };
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

  // size_trajectory is parsed independently of the shape check above --
  // a malformed trajectory must never flip outcome to "error". Sanitize
  // it here, at the parse boundary, so nothing downstream (loop-runner's
  // RunLogLine carry-over, runs.jsonl) ever sees an unvalidated value.
  const verdict = parsed as Verdict;
  if (verdict.size_trajectory !== undefined) {
    const sanitized = parseSizeTrajectory(verdict.size_trajectory);
    if (sanitized === null) {
      delete verdict.size_trajectory;
    } else {
      verdict.size_trajectory = sanitized;
    }
  }

  return verdict;
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
