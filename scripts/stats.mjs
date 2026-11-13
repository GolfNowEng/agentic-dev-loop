// Success/failure rollup over a project's run logs. Read-only, no
// dependencies. Run with:
//   npm run stats [-- --project=webtarsthree --days=N --v1 --root=<dir>]
//
// Default (v2): runs/v2/<project>.jsonl, counted per role from PHASE
// entries (a record may hold a research and a dev phase; records with no
// phases, e.g. handoff-done or interrupted, contribute nothing). A phase
// is in the window when its `started` is within --days=N (default 7).
// After the role lines, "parked: <n> ticket(s) currently parked" when any
// ticket's latest record is `parked` (not windowed).
//
// --v1: the v1 logs, dev and research reported separately. Each role reads
// runs/v1/<role>/<project>.jsonl when it exists, else the pre-cutover live
// log (dev: runs/<project>.jsonl, research: research-loop/runs/<project>.jsonl);
// the output names the file read.
//
// --root: the state root the paths above are under (default: this repo's
// root). Never writes anything.

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { FlagError, parseFlags } from "../src/core/flags.ts";

let flags;
try {
  flags = parseFlags(process.argv.slice(2), { values: ["--project", "--days", "--root"], bools: ["--v1"] }, "stats");
} catch (err) {
  if (!(err instanceof FlagError)) throw err;
  console.error(err.message);
  process.exit(1);
}
const days = Number(flags.values["--days"] ?? "7");
const project = flags.values["--project"] ?? "webtarsthree";
const root = resolve(flags.values["--root"] ?? resolve(import.meta.dirname, ".."));
const v1 = flags.bools.has("--v1");

if (!/^[a-z0-9-]+$/.test(project)) {
  console.error(`--project=${JSON.stringify(project)} must match /^[a-z0-9-]+$/`);
  process.exit(1);
}
if (!Number.isFinite(days) || days <= 0) {
  console.error(`--days=N must be a positive number`);
  process.exit(1);
}

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
const inWindow = (started) => {
  const t = Date.parse(started);
  return !Number.isNaN(t) && t >= cutoff;
};

/** Parsed objects, plus how many non-blank lines were unreadable; null if the file is missing. */
async function readJsonl(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const rows = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") rows.push(v);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

/** One summary line from entries with {outcome, cost_usd, failure_category}. */
function tally(entries) {
  const n = { total: entries.length, landed: 0, bounced: 0, failed: 0, cost: 0, other: {}, categories: {} };
  for (const e of entries) {
    if (e.outcome === "landed") n.landed++;
    else if (e.outcome === "bounced") n.bounced++;
    else if (e.outcome === "error" || e.outcome === "killed") n.failed++;
    else n.other[e.outcome] = (n.other[e.outcome] ?? 0) + 1;
    if (e.failure_category) n.categories[e.failure_category] = (n.categories[e.failure_category] ?? 0) + 1;
    n.cost += typeof e.cost_usd === "number" ? e.cost_usd : 0;
  }
  return n;
}

function render(label, unit, n) {
  const out = [`${label}${n.total} ${unit}(s) -- ${n.landed} landed, ${n.bounced} bounced, ${n.failed} error/killed, cost $${n.cost.toFixed(2)}`];
  for (const [k, v] of Object.entries(n.other)) out.push(`    ${k}: ${v}`);
  const cats = Object.entries(n.categories);
  if (cats.length > 0) out.push(`    by failure_category: ${cats.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return out.join("\n");
}

if (!v1) {
  const path = join(root, "runs/v2", `${project}.jsonl`);
  const log = await readJsonl(path);
  if (!log) {
    console.log(`No v2 log at ${path} yet -- no runs recorded. (Use --v1 for the v1 logs.)`);
    process.exit(0);
  }
  console.log(`v2 ${path}, last ${days} day(s):`);
  for (const role of ["research", "dev"]) {
    const phases = log.rows
      .flatMap((r) => (Array.isArray(r.phases) ? r.phases : []))
      .filter((p) => p && p.role === role && inWindow(p.started));
    console.log(render(`  ${role}: `, "phase", tally(phases)));
  }
  // Currently parked: the ticket's latest record (by ended, file order breaks ties) is "parked". Not windowed.
  const latest = new Map();
  for (const r of log.rows) {
    if (typeof r.ticket !== "string") continue;
    const prev = latest.get(r.ticket);
    if (!prev || String(r.ended) >= String(prev.ended)) latest.set(r.ticket, r);
  }
  const parked = [...latest.values()].filter((r) => r.outcome === "parked").length;
  if (parked > 0) console.log(`  parked: ${parked} ticket(s) currently parked`);
  if (log.skipped > 0) console.log(`  (${log.skipped} unreadable line(s) skipped)`);
  process.exit(0);
}

const PRE_CUTOVER = { dev: join(root, "runs", `${project}.jsonl`), research: join(root, "research-loop/runs", `${project}.jsonl`) };
for (const role of ["dev", "research"]) {
  const post = join(root, "runs/v1", role, `${project}.jsonl`);
  let path = post;
  let log = await readJsonl(post);
  let layout = "post-cutover";
  if (!log) {
    path = PRE_CUTOVER[role];
    log = await readJsonl(path);
    layout = "pre-cutover";
  }
  if (!log) {
    console.log(`v1 ${role}: no log (looked for ${post} and ${PRE_CUTOVER[role]})`);
    continue;
  }
  console.log(`v1 ${role} (${path}, ${layout}), last ${days} day(s):`);
  console.log(render("  ", "run", tally(log.rows.filter((l) => inWindow(l.started)))));
  if (log.skipped > 0) console.log(`  (${log.skipped} unreadable line(s) skipped)`);
}
