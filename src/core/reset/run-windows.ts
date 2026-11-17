// The ticket's run windows: when each of its runs could have posted to Jira.
// From every phase in the live runs log and the reset archive
// ([started, ended + 2 min]), every claim-error record (research,
// [started - 2 min, ended + 2 min]) and from every run dir of the ticket, any
// session, with a progress.jsonl ([first ts, last ts + 2 min]), so a run
// stopped mid-way with no record still has a window. Read before anything is
// archived or deleted (the runner surveys every row before running any).
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readIterations } from "../iteration-log.ts";
import { resolveRepoPath, RUN_ID, SESSION_ID, v2ProjectDir, v2RunsArchive, v2RunsLog } from "../paths.ts";
import type { Role } from "../types.ts";
import type { ResetCtx } from "./context.ts";

export interface RunWindow {
  role: Role;
  from: number;
  to: number;
}

export const WINDOW_SLACK_MS = 120_000;

export function resetPath(ctx: ResetCtx, rel: string): string {
  return ctx.root === undefined ? resolveRepoPath(rel) : resolve(ctx.root, rel);
}

const isRole = (r: unknown): r is Role => r === "research" || r === "dev";

const listDir = async (p: string): Promise<string[]> => {
  try {
    return (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

export async function runWindows(ctx: ResetCtx): Promise<RunWindow[]> {
  const out: RunWindow[] = [];
  for (const rel of [v2RunsLog(ctx.slug), v2RunsArchive(ctx.slug)]) {
    for (const rec of await readIterations(resetPath(ctx, rel))) {
      if (rec.ticket !== ctx.ticket) continue;
      // The research claim posts its missing-fields comment just before this
      // phase-less record is appended, so its window has slack on both sides.
      if (rec.outcome === "claim-error") {
        const from = Date.parse(rec.started);
        const to = Date.parse(rec.ended);
        if (Number.isFinite(from) && Number.isFinite(to)) out.push({ role: "research", from: from - WINDOW_SLACK_MS, to: to + WINDOW_SLACK_MS });
      }
      for (const p of rec.phases) {
        const from = Date.parse(p.started);
        const to = Date.parse(p.ended);
        if (isRole(p.role) && Number.isFinite(from) && Number.isFinite(to)) out.push({ role: p.role, from, to: to + WINDOW_SLACK_MS });
      }
    }
  }

  const projectDir = resetPath(ctx, v2ProjectDir(ctx.slug));
  for (const session of await listDir(projectDir)) {
    if (!SESSION_ID.test(session)) continue;
    const ticketDir = join(projectDir, session, ctx.ticket);
    for (const name of await listDir(ticketDir)) {
      const m = /^(research|dev)-(.+)$/.exec(name);
      if (!m || !RUN_ID.test(m[2])) continue;
      const w = await progressWindow(join(ticketDir, name, "progress.jsonl"));
      if (w) out.push({ role: m[1] as Role, ...w });
    }
  }
  return out;
}

/** [first ts, last ts + slack] of a progress.jsonl; unparseable lines skipped; null if none usable. */
async function progressWindow(path: string): Promise<{ from: number; to: number } | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let from = Infinity;
  let to = -Infinity;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let ts: number;
    try {
      ts = Date.parse((JSON.parse(line) as { ts?: unknown }).ts as string);
    } catch {
      continue;
    }
    if (!Number.isFinite(ts)) continue;
    from = Math.min(from, ts);
    to = Math.max(to, ts);
  }
  return Number.isFinite(from) ? { from, to: to + WINDOW_SLACK_MS } : null;
}
