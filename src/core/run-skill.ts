// The one injected boundary between the worker cycle and a real `claude -p`
// spawn. main.ts builds the real implementation over spawn-claude.ts; tests
// pass a scripted fake. Both role phases take it.

import type { Role } from "./types.ts";
import type { RunSandboxMeta } from "./iteration-log.ts";
import type { SandboxDenial } from "../sandbox/types.ts";

export interface RunSkillArgs {
  role: Role;
  ticketKey: string;
  /** v2RunDir(...) for this phase run (repo-relative). The skill gets it, absolute, as `run-dir=`. */
  runDir: string;
  /** `--max-budget-usd` for this spawn (Ruling 16: the per-run cap, clipped to what is left of the per-ticket cap). */
  maxBudgetUsd: number;
}

export interface RunSkillResult {
  /** Raw verdict.json text (already redacted), or undefined when the skill never wrote one. */
  verdictRaw: string | undefined;
  /** ISO-8601 UTC. */
  started: string;
  /** ISO-8601 UTC. */
  ended: string;
  /** Measured cost from claude -p's usage report (never the skill's self-report). */
  costUsd: number;
  /** Measured tokens from claude -p's usage report. */
  tokens: { in: number; out: number };
  /** Git SHA of the skill's SKILL.md at run time. */
  skillVersion: string;
  model: string;
  /**
   * Set only when an enforcing sandbox refused something (or could not start):
   * the run is parked, not judged, and verdictRaw is undefined.
   */
  parked?: {
    denied: SandboxDenial[];
    approveHint?: string;
    /** Every denial is kind "infra" (the sandbox itself failed, nothing ticket-specific): the worker pauses. */
    allInfra?: true;
  };
  /** Set only when the spawn went through a sandbox: which one (no report). */
  sandbox?: RunSandboxMeta;
}

export type RunSkillFn = (args: RunSkillArgs) => Promise<RunSkillResult>;

/** Wall-clock minutes between two ISO timestamps (0 if either is unparseable). */
export function durationMin(started: string, ended: string): number {
  const ms = Date.parse(ended) - Date.parse(started);
  return Number.isFinite(ms) ? ms / 60_000 : 0;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
