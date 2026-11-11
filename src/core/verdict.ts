// Parses a skill's verdict.json into a Verdict. This parser must NEVER
// throw on bad input - missing or malformed verdict.json is an expected
// failure mode (the agent crashed, wrote garbage, or wrote nothing) and
// must be represented as outcome "error" / failure_category "agent_error",
// not as an exception that takes down the loop.
//
// Two shape profiles, because the two skills write different schemas:
//   - "refine" (default; ticket-refine): only outcome/phase_reached/
//     failure_category/detail are required, and outcome may be "ready".
//   - "executor" (ticket-to-pr): additionally requires every executor field
//     (red_confirmed, verify_loops, retries, skill_version, model, pr,
//     cost_usd, tokens) and rejects "ready". The dev role reads those fields
//     unconditionally, so a verdict missing one is an agent_error, not a
//     Verdict with silently-undefined fields.

import { readFile } from "node:fs/promises";
import type {
  ExecutorVerdict,
  PhaseReached,
  RunOutcome,
  SizeDelta,
  SizeTrajectory,
  TShirtSize,
  Verdict,
  VerdictOutcome,
} from "./types.ts";

/** Which skill's verdict.json schema to validate against. */
export type VerdictProfile = "refine" | "executor";

const RUN_OUTCOMES: RunOutcome[] = ["landed", "bounced", "error", "killed"];
const VERDICT_OUTCOMES: VerdictOutcome[] = [...RUN_OUTCOMES, "ready"];
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

  if (!VERDICT_OUTCOMES.includes(v.outcome as VerdictOutcome)) return false;
  if (!VALID_PHASES.includes(v.phase_reached as PhaseReached)) return false;
  if (v.failure_category !== null && typeof v.failure_category !== "string") {
    return false;
  }
  if (typeof v.detail !== "string") return false;

  return true;
}

function isValidExecutorShape(v: Verdict): v is ExecutorVerdict {
  if (!RUN_OUTCOMES.includes(v.outcome as RunOutcome)) return false;
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
 * Parses a shadow-mode `size_trajectory` value. Fully independent of the
 * shape checks -- a malformed trajectory returns null and must never flip a
 * Verdict's `outcome` to "error". Pure telemetry: nothing downstream acts
 * on the parsed value yet.
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

/**
 * Build the canonical "agent_error" Verdict used whenever verdict.json is
 * missing or malformed. Centralized so every error path produces an
 * identical shape. It carries every executor field (zeroed), so it is a
 * valid result for both profiles.
 */
export function agentErrorVerdict(detail: string): ExecutorVerdict {
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
export function parseVerdict(raw: string | null | undefined): Verdict;
export function parseVerdict(raw: string | null | undefined, profile: "refine"): Verdict;
export function parseVerdict(raw: string | null | undefined, profile: "executor"): ExecutorVerdict;
export function parseVerdict(
  raw: string | null | undefined,
  profile: VerdictProfile = "refine",
): Verdict {
  if (raw === null || raw === undefined) {
    return agentErrorVerdict("verdict.json was missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return agentErrorVerdict("verdict.json contained malformed JSON");
  }

  if (
    !isValidVerdictShape(parsed) ||
    (profile === "executor" && !isValidExecutorShape(parsed))
  ) {
    return agentErrorVerdict(
      "verdict.json did not match the expected Verdict shape",
    );
  }

  // size_trajectory is parsed independently of the shape check above --
  // a malformed trajectory must never flip outcome to "error". Sanitize
  // it here, at the parse boundary, so nothing downstream (RunLogLine
  // carry-over, runs.jsonl) ever sees an unvalidated value.
  const verdict = parsed;
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
 * Read and parse verdict.json from disk at the given path. Missing file,
 * unreadable file, or malformed JSON all resolve to an "error" /
 * "agent_error" Verdict rather than rejecting.
 */
export async function readVerdictFile(path: string): Promise<Verdict>;
export async function readVerdictFile(path: string, profile: "refine"): Promise<Verdict>;
export async function readVerdictFile(path: string, profile: "executor"): Promise<ExecutorVerdict>;
export async function readVerdictFile(
  path: string,
  profile: VerdictProfile = "refine",
): Promise<Verdict> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return agentErrorVerdict(`verdict.json could not be read: ${message}`);
  }
  return profile === "executor" ? parseVerdict(raw, "executor") : parseVerdict(raw);
}

/**
 * research-loop's names for the same functions (research-loop/src/verdict.ts
 * called them errorVerdict/readVerdict; dev-loop called them
 * agentErrorVerdict/readVerdictFile). Same function objects, so the role
 * code ported in Task 4 can keep its own call sites.
 */
export const errorVerdict = agentErrorVerdict;
export const readVerdict = readVerdictFile;
