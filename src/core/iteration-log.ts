// The v2 per-ticket-iteration log: one append-only JSONL line per queue
// iteration (runs/v2/<project>.jsonl), plus readers, counters and the
// landed-PR lookups that span the v1 and v2 log generations.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { redactSensitive } from "./redact.ts";
import { resolveRepoPath, SESSION_ID, TICKET_KEY, v1RunsLog, v2RunsLog } from "./paths.ts";
import type { FailureCategory, PhaseReached, Role, RunOutcome, SizeTrajectory } from "./types.ts";

export interface PhaseEntry {
  role: Role;
  skill: "ticket-refine" | "ticket-to-pr";
  skill_version: string;
  model: string;
  started: string;
  ended: string;
  outcome: RunOutcome;
  phase_reached: PhaseReached;
  cost_usd: number;
  tokens: { in: number; out: number };
  failure_category: FailureCategory | null;
  detail: string;
  pr: string | null;
  run_dir: string;
  red_confirmed?: boolean;
  verify_loops?: number;
  retries?: number;
  size_trajectory?: SizeTrajectory;
  /** Research entries with outcome landed only. */
  handoff?: "done" | "skipped-ceiling" | "failed";
  jira_sync_error?: string;
}

export type IterationOutcome =
  | "landed"
  | "bounced"
  | "error"
  | "killed"
  | "skipped-blocked"
  | "claim-error"
  | "handoff-pending"
  | "skipped-pr-exists"
  | "blocked-attempts"
  /** Step 1 completed a pending research -> dev label handoff (phases: []). */
  | "handoff-done"
  /** A phase run stopped by SIGINT/SIGTERM; not a failed attempt (phases: [], resume set). */
  | "interrupted";

export interface IterationRecord {
  ticket: string;
  session: string;
  loop_version: string;
  started: string;
  ended: string;
  outcome: IterationOutcome;
  phases: PhaseEntry[];
  blocked_by?: string[];
  /**
   * Set when this ticket has a phase run of this role to resume (a crashed or
   * interrupted in-flight run, or a claim whose phase never started). The
   * ticket's latest record carrying it means "pending"; any later record
   * resolves it. Only a process that runs this role resumes it.
   */
  resume?: Role;
  detail?: string;
  jira_sync_error?: string;
}

/** A landed ticket with its PR, from whichever log generation recorded it. */
export interface LandedTicket {
  ticket: string;
  pr: string;
  source: "v1" | "v2";
  ended: string;
}

function redactOpt(s: string | undefined): string | undefined {
  return s === undefined ? undefined : redactSensitive(s);
}

/** Append one JSON line (single appendFile call). Validates ticket/session; redacts free text. */
export async function appendIteration(path: string, rec: IterationRecord): Promise<void> {
  if (typeof rec.ticket !== "string" || !TICKET_KEY.test(rec.ticket)) {
    throw new Error(`appendIteration: invalid ticket ${JSON.stringify(rec.ticket)}`);
  }
  if (typeof rec.session !== "string" || !SESSION_ID.test(rec.session)) {
    throw new Error(`appendIteration: invalid session ${JSON.stringify(rec.session)}`);
  }
  const out: IterationRecord = {
    ...rec,
    phases: rec.phases.map((p) => {
      const q: PhaseEntry = { ...p, detail: redactSensitive(p.detail) };
      if (p.jira_sync_error !== undefined) q.jira_sync_error = redactSensitive(p.jira_sync_error);
      return q;
    }),
  };
  if (rec.detail !== undefined) out.detail = redactOpt(rec.detail);
  if (rec.jira_sync_error !== undefined) out.jira_sync_error = redactOpt(rec.jira_sync_error);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(out)}\n`, "utf8");
}

/** Like readIterations, but also reports how many non-blank lines were skipped as unusable. */
export async function readIterationsDetailed(path: string): Promise<{ records: IterationRecord[]; skipped: number }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 };
    throw e;
  }
  const records: IterationRecord[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++; // malformed, or a truncated final line from a crash mid-append
      continue;
    }
    const r = parsed as Partial<IterationRecord> | null;
    if (!r || typeof r !== "object" || typeof r.ticket !== "string" || !TICKET_KEY.test(r.ticket)) {
      skipped++;
      continue;
    }
    records.push({ ...(r as IterationRecord), phases: Array.isArray(r.phases) ? r.phases : [] });
  }
  return { records, skipped };
}

/** All usable records in file order; missing file -> []. Never throws on bad lines. */
export async function readIterations(path: string): Promise<IterationRecord[]> {
  return (await readIterationsDetailed(path)).records;
}

/** Phase entries of `role` whose `started` is on now's UTC day. */
export async function countPhaseRunsToday(path: string, role: Role, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  let n = 0;
  for (const r of await readIterations(path)) {
    for (const p of r.phases) if (p.role === role && p.started.slice(0, 10) === day) n++;
  }
  return n;
}

export function hasLandedPhase(records: IterationRecord[], ticket: string, role: Role): boolean {
  return records.some((r) => r.ticket === ticket && r.phases.some((p) => p.role === role && p.outcome === "landed"));
}

/** error/killed entries of `role` since the ticket's last landed/bounced entry of that role (chronological). */
export function failedAttempts(records: IterationRecord[], ticket: string, role: Role): number {
  const entries = records
    .filter((r) => r.ticket === ticket)
    .flatMap((r) => r.phases)
    .filter((p) => p.role === role)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.started < b.p.started ? -1 : a.p.started > b.p.started ? 1 : a.i - b.i));
  let n = 0;
  for (const { p } of entries) {
    if (p.outcome === "landed" || p.outcome === "bounced") n = 0;
    else if (p.outcome === "error" || p.outcome === "killed") n++;
  }
  return n;
}

/** Tickets with any record ended within windowMs of now. */
export function recentlyEnded(records: IterationRecord[], now: Date, windowMs: number): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    const t = Date.parse(r.ended);
    if (!Number.isNaN(t) && now.getTime() - t <= windowMs) out.add(r.ticket);
  }
  return out;
}

/** blocked_by of the ticket's latest record (by ended) if it is skipped-blocked, else null. */
export function lastSkipBlockers(records: IterationRecord[], ticket: string): string[] | null {
  let latest: IterationRecord | null = null;
  for (const r of records) {
    if (r.ticket === ticket && (latest === null || r.ended >= latest.ended)) latest = r;
  }
  return latest && latest.outcome === "skipped-blocked" ? (latest.blocked_by ?? []) : null;
}

// ---- landed lookups across log generations ----

function abs(rel: string, root?: string): string {
  return root === undefined ? resolveRepoPath(rel) : resolve(root, rel);
}

async function v2Landed(slug: string, root?: string): Promise<Map<string, LandedTicket>> {
  const latest = new Map<string, LandedTicket>();
  for (const r of await readIterations(abs(v2RunsLog(slug), root))) {
    for (const p of r.phases) {
      if (p.role !== "dev" || p.outcome !== "landed" || !p.pr) continue;
      const prev = latest.get(r.ticket);
      if (!prev || r.ended >= prev.ended) latest.set(r.ticket, { ticket: r.ticket, pr: p.pr, source: "v2", ended: r.ended });
    }
  }
  return latest;
}

async function v1Landed(slug: string, root?: string): Promise<Map<string, LandedTicket>> {
  const latest = new Map<string, LandedTicket>();
  let raw: string;
  try {
    raw = await readFile(abs(v1RunsLog("dev", slug), root), "utf8");
  } catch {
    return latest;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const l = JSON.parse(line) as { ticket?: unknown; outcome?: unknown; pr?: unknown; ended?: unknown };
      if (l.outcome === "landed" && typeof l.pr === "string" && l.pr && typeof l.ticket === "string" && TICKET_KEY.test(l.ticket)) {
        latest.set(l.ticket, { ticket: l.ticket, pr: l.pr, source: "v1", ended: typeof l.ended === "string" ? l.ended : "" });
      }
    } catch {
      /* skip bad line */
    }
  }
  return latest;
}

/** Latest landed dev PR for the ticket: v2 first, else the v1 dev log. */
export async function findLandedPrUrlAcross(slug: string, ticketKey: string, root?: string): Promise<string | null> {
  return (await v2Landed(slug, root)).get(ticketKey)?.pr ?? (await v1Landed(slug, root)).get(ticketKey)?.pr ?? null;
}

/** Union of landed tickets, de-duped by ticket; v2 wins. */
export async function findLandedTicketsAcross(slug: string, root?: string): Promise<LandedTicket[]> {
  const merged = await v1Landed(slug, root);
  for (const [k, v] of await v2Landed(slug, root)) merged.set(k, v);
  return [...merged.values()];
}
