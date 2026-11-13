// Parked tickets: runs an enforcing sandbox refused. Lists them with what was
// refused and the adapter's allow hint, and un-parks one. Also lists what a
// discover-mode run would have been refused (it carried on, so nothing to clear). It only PRINTS the
// hint; it never runs it. Run with:
//   npm run sandbox:approvals [-- --project=webtarsthree --root=<dir>]
//   npm run sandbox:approvals -- --clear=<KEY>
//
// Reads/appends runs/v2/<project>.jsonl under --root (default: this repo's
// root). --clear=<KEY> appends one "unparked" record (the same single-line
// append the loop uses, so it is safe while a loop runs); the next loop
// iteration resumes the ticket's parked role.

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { FlagError, parseFlags } from "../src/core/flags.ts";
import { appendIteration, readIterations } from "../src/core/iteration-log.ts";

let flags;
try {
  flags = parseFlags(process.argv.slice(2), { values: ["--project", "--root", "--clear"], bools: [] }, "sandbox:approvals");
} catch (err) {
  if (!(err instanceof FlagError)) throw err;
  console.error(err.message);
  process.exit(1);
}
const project = flags.values["--project"] ?? "webtarsthree";
const root = resolve(flags.values["--root"] ?? resolve(import.meta.dirname, ".."));
const clear = flags.values["--clear"];

if (!/^[a-z0-9-]+$/.test(project)) {
  console.error(`--project=${JSON.stringify(project)} must match /^[a-z0-9-]+$/`);
  process.exit(1);
}

const path = join(root, "runs/v2", `${project}.jsonl`);
const records = await readIterations(path);

// Latest record per ticket (by ended; file order breaks ties), in first-seen order.
const latest = new Map();
for (const r of records) {
  const prev = latest.get(r.ticket);
  if (!prev || String(r.ended) >= String(prev.ended)) latest.set(r.ticket, r);
}
const parked = [...latest.values()].filter((r) => r.outcome === "parked");

if (clear !== undefined) {
  const rec = latest.get(clear);
  if (!rec || rec.outcome !== "parked") {
    console.log(`${clear} is not parked (latest outcome: ${rec ? rec.outcome : "none"}).`);
    process.exit(1);
  }
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const role = rec.parked?.role ?? rec.resume;
  const now = new Date().toISOString();
  await appendIteration(path, {
    ticket: clear,
    session: "approvals",
    loop_version: pkg.version,
    started: now,
    ended: now,
    outcome: "unparked",
    phases: [],
    resume: role,
    detail: "cleared by sandbox:approvals",
  });
  console.log(`${clear}: unparked; the next loop iteration resumes its ${role} phase.`);
  process.exit(0);
}

// Discover mode: what the sandbox would have refused, kept on the latest record's phase entries.
const discovered = [...latest.values()].filter((r) => (r.phases ?? []).some((p) => (p.sandbox?.denied ?? []).length > 0));

if (parked.length === 0) console.log(`No parked tickets in ${path}.`);
for (const r of parked) {
  const p = r.parked ?? {};
  console.log(`${r.ticket} (${p.role ?? r.resume}, parked ${r.ended}):`);
  for (const d of p.denied ?? []) console.log(`  refused: ${d.kind} ${d.target}`);
  if (p.approveHint) console.log(`  to allow (run these yourself): ${p.approveHint}`);
  console.log(`  then: npm run sandbox:approvals -- --clear=${r.ticket}`);
}
if (discovered.length > 0) {
  console.log("");
  console.log("Discovered in discover mode (not parked):");
  for (const r of discovered) {
    for (const p of r.phases.filter((x) => (x.sandbox?.denied ?? []).length > 0)) {
      console.log(`${r.ticket} (${p.role}, ${p.ended}):`);
      for (const d of p.sandbox.denied) console.log(`  refused: ${d.kind} ${d.target}`);
      if (p.sandbox.approveHint) console.log(`  to allow (run these yourself): ${p.sandbox.approveHint}`);
    }
  }
}
