// The per-ticket reset checklist: survey every step (read-only), print one
// table, ask once, run the approved rows in AREA_ORDER, then re-survey the
// SAME step instances (steps keep state between passes: jira's listed
// comments, local's shared executeReset) and say whether the ticket is at
// zero. A row whose run threw is never at zero, even if its re-survey reads
// clean.
import { AREA_ORDER, atZero, type ResetStep, type SurveyedRow } from "./step.ts";
import { renderTable } from "./table.ts";

export interface RunnerIO {
  print(s: string): void;
  /** One answer line, or null when there is no terminal to ask on. */
  ask(q: string): Promise<string | null>;
}

export interface RunnerOpts {
  title: string;
  ticket: string;
  dryRun: boolean;
  yes: boolean;
  /** Re-checked right before execute; a message refuses the run. */
  preExecuteCheck: () => Promise<string | null>;
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.trim();

async function surveyAll(steps: ResetStep[]): Promise<SurveyedRow[]> {
  const rows: SurveyedRow[] = [];
  for (const step of steps) {
    try {
      rows.push({ step, survey: await step.survey() });
    } catch (e) {
      rows.push({ step, survey: { found: "-", action: null }, error: firstLine(e) });
    }
  }
  return rows;
}

const runnable = (r: SurveyedRow): boolean =>
  !r.error && !r.survey.needsYou && r.survey.action !== null && typeof r.survey.run === "function";

/** The first row (other than a pollable one) that keeps the ticket off the poll, as "<area> <step> <why>". */
function blocker(rows: SurveyedRow[], failed: Map<ResetStep, string>): string | null {
  for (const r of rows) {
    if (r.step.makesPollable) continue;
    if (failed.has(r.step)) return `${r.step.area} ${r.step.name} failed`;
    if (r.error || r.survey.needsYou) return `${r.step.area} ${r.step.name} needs you`;
  }
  return null;
}

const HELD_NOTE = "held until the rows that need you are clean";

export async function runChecklist(steps: ResetStep[], opts: RunnerOpts, io: RunnerIO): Promise<number> {
  const rows = await surveyAll(steps);
  if (blocker(rows, new Map()) !== null) {
    for (const r of rows) {
      if (r.step.makesPollable && runnable(r)) r.survey = { ...r.survey, details: [...(r.survey.details ?? []), HELD_NOTE] };
    }
  }
  io.print(renderTable(opts.title, rows));

  if (rows.every(atZero)) {
    io.print(`[reset] ${opts.ticket} is already at zero.`);
    return 0;
  }
  if (opts.dryRun) {
    io.print("[reset] --dry-run: nothing changed.");
    return 0;
  }
  if (!opts.yes) {
    const answer = await io.ask("Proceed? [y/N] ");
    if (answer === null) {
      io.print("[reset] no terminal to ask on: rerun with --yes after reviewing the table above.");
      return 1;
    }
    const a = answer.trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      io.print("[reset] declined: nothing changed.");
      return 0;
    }
  }
  const refusal = await opts.preExecuteCheck();
  if (refusal !== null) {
    io.print(refusal);
    return 1;
  }

  // AREA_ORDER, then table order within an area (sort is stable); a step that
  // makes the ticket pollable goes after every other row.
  const rank = (r: SurveyedRow): number => (r.step.makesPollable ? AREA_ORDER.length : AREA_ORDER.indexOf(r.step.area));
  const order = rows.filter(runnable).sort((a, b) => rank(a) - rank(b));
  const status = new Map<SurveyedRow, string>();
  const failed = new Map<ResetStep, string>();
  for (const row of order) {
    try {
      if (row.step.makesPollable) {
        const why = blocker(rows, failed);
        if (why !== null) throw new Error(`held: ${why}`);
      }
      await row.survey.run!();
      status.set(row, "done");
    } catch (e) {
      const msg = `failed: ${firstLine(e)}`;
      status.set(row, msg);
      failed.set(row.step, msg);
    }
  }
  io.print("");
  io.print(renderTable("Ran", rows, status));

  const after = await surveyAll(steps);
  const afterStatus = new Map<SurveyedRow, string>();
  for (const r of after) {
    const f = failed.get(r.step);
    if (f !== undefined) afterStatus.set(r, f);
  }
  io.print("");
  io.print(renderTable("After reset", after, afterStatus));

  const needYou: string[] = [];
  for (const r of after) {
    const why =
      failed.get(r.step) ??
      r.error ??
      r.survey.needsYou ??
      (r.survey.action !== null ? `still to do: ${r.survey.action}` : null);
    if (why !== null) needYou.push(`  - ${r.step.area} ${r.step.name}: ${why}`);
  }
  if (needYou.length === 0) {
    io.print(`[reset] ${opts.ticket} is at zero.`);
    return 0;
  }
  io.print(`[reset] ${opts.ticket} is not at zero: ${needYou.length} step(s) need you:`);
  for (const l of needYou) io.print(l);
  return 1;
}
