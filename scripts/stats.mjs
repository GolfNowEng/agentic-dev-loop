// Success/failure rate rollup over runs.jsonl. Run with:
//   npm run stats [-- --days N]
//
// Default lookback is 7 days. This is the "track success/failure rates over
// time" view -- runs.jsonl already has everything needed (outcome,
// failure_category, timestamps); this just aggregates it instead of making
// you remember a jq incantation.

import { readFile } from "node:fs/promises";

const daysArgIndex = process.argv.indexOf("--days");
const days =
  daysArgIndex !== -1 && process.argv[daysArgIndex + 1]
    ? Number(process.argv[daysArgIndex + 1])
    : 7;

const RUNS_LOG_PATH = "./runs.jsonl";

let raw;
try {
  raw = await readFile(RUNS_LOG_PATH, "utf8");
} catch {
  console.log(`No ${RUNS_LOG_PATH} yet -- no runs recorded.`);
  process.exit(0);
}

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

const lines = raw
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l))
  .filter((line) => new Date(line.started).getTime() >= cutoff);

if (lines.length === 0) {
  console.log(`No runs in the last ${days} day(s).`);
  process.exit(0);
}

const byOutcome = {};
const byFailureCategory = {};
let totalCostUsd = 0;

for (const line of lines) {
  byOutcome[line.outcome] = (byOutcome[line.outcome] ?? 0) + 1;
  if (line.failure_category) {
    byFailureCategory[line.failure_category] =
      (byFailureCategory[line.failure_category] ?? 0) + 1;
  }
  totalCostUsd += line.cost_usd ?? 0;
}

const total = lines.length;
const landed = byOutcome.landed ?? 0;
const pct = (n) => `${((n / total) * 100).toFixed(0)}%`;

console.log(`Last ${days} day(s): ${total} run(s) -- ${landed} landed (${pct(landed)})`);
for (const [outcome, count] of Object.entries(byOutcome)) {
  if (outcome === "landed") continue;
  console.log(`  ${outcome}: ${count} (${pct(count)})`);
}

if (Object.keys(byFailureCategory).length > 0) {
  console.log("By failure_category:");
  for (const [category, count] of Object.entries(byFailureCategory)) {
    console.log(`  ${category}: ${count}`);
  }
}

console.log(`Total cost: $${totalCostUsd.toFixed(2)}`);
