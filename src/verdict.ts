// Parses a skill's verdict.json into a Verdict. This parser must NEVER
// throw on bad input - missing or malformed verdict.json is an expected
// failure mode (the agent crashed, wrote garbage, or wrote nothing) and
// must be represented as outcome "error" / failure_category "agent_error",
// not as an exception that takes down the loop.

import { readFile } from "node:fs/promises";
import type { RunOutcome, RunPhase, Verdict } from "./types.js";

const VALID_OUTCOMES: RunOutcome[] = ["landed", "bounced", "error", "killed"];
const VALID_PHASES: RunPhase[] = [
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
  if (!VALID_PHASES.includes(v.phase_reached as RunPhase)) return false;
  if (v.failure_category !== null && typeof v.failure_category !== "string") {
    return false;
  }
  if (typeof v.detail !== "string") return false;
  if (typeof v.red_confirmed !== "boolean") return false;
  if (typeof v.verify_loops !== "number") return false;
  if (typeof v.retries !== "number") return false;
  if (typeof v.skill_version !== "string") return false;
  if (typeof v.model !== "string") return false;
  if (v.pr !== null && typeof v.pr !== "string") return false;
  if (typeof v.cost_usd !== "number") return false;

  if (typeof v.tokens !== "object" || v.tokens === null) return false;
  const tokens = v.tokens as Record<string, unknown>;
  if (typeof tokens.in !== "number" || typeof tokens.out !== "number") {
    return false;
  }

  return true;
}

/**
 * Build the canonical "agent_error" Verdict used whenever verdict.json is
 * missing or malformed. Centralized so every error path produces an
 * identical shape.
 */
export function agentErrorVerdict(detail: string): Verdict {
  return {
    outcome: "error",
    phase_reached: "intake",
    failure_category: "agent_error",
    detail,
    red_confirmed: false,
    verify_loops: 0,
    retries: 0,
    skill_version: "",
    model: "",
    pr: null,
    cost_usd: 0,
    tokens: { in: 0, out: 0 },
  };
}

/**
 * Parse a verdict.json file's raw string contents (or undefined/null if
 * the file was missing) into a Verdict. On any parse/shape failure,
 * returns a Verdict with outcome "error" and failure_category
 * "agent_error" instead of throwing.
 */
export function parseVerdict(raw: string | null | undefined): Verdict {
  if (raw === null || raw === undefined) {
    return agentErrorVerdict("verdict.json was missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return agentErrorVerdict("verdict.json contained malformed JSON");
  }

  if (!isValidVerdictShape(parsed)) {
    return agentErrorVerdict(
      "verdict.json did not match the expected Verdict shape",
    );
  }

  return parsed;
}

/**
 * Read and parse verdict.json from disk at the given path. Missing file,
 * unreadable file, or malformed JSON all resolve to an "error" /
 * "agent_error" Verdict rather than rejecting.
 */
export async function readVerdictFile(path: string): Promise<Verdict> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return agentErrorVerdict(`verdict.json could not be read: ${message}`);
  }
  return parseVerdict(raw);
}
