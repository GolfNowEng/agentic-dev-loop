// EXPERIMENTAL / THROWAWAY -- see docs/future-enhancements.md's size-score
// entry. This script exists only to answer one question: once enough
// passing runs have logged size_trajectory (shadow-mode telemetry, see
// docs/skills.md), does the mechanical score actually track what a human
// would call small/medium/large? It is not wired into any gate or verdict
// and nothing depends on it. Delete it once that question is answered one
// way or the other -- it is not meant to become permanent tooling.
//
// Run with:
//   npm run size-checkpoint [-- --project webtarsthree --threshold 15]
//
// A line counts toward the threshold only if it has a size_trajectory
// field at all -- every run before this field existed has none, so this
// is automatically "starting now," no date cutoff needed.

import { readFile } from "node:fs/promises";

const projectArgIndex = process.argv.indexOf("--project");
const project =
  projectArgIndex !== -1 && process.argv[projectArgIndex + 1]
    ? process.argv[projectArgIndex + 1]
    : "webtarsthree";

const thresholdArgIndex = process.argv.indexOf("--threshold");
const threshold =
  thresholdArgIndex !== -1 && process.argv[thresholdArgIndex + 1]
    ? Number(process.argv[thresholdArgIndex + 1])
    : 15;

const RUNS_LOG_PATH = `./runs/${project}.jsonl`;

let raw;
try {
  raw = await readFile(RUNS_LOG_PATH, "utf8");
} catch {
  console.log(`No ${RUNS_LOG_PATH} yet -- no runs recorded.`);
  process.exit(0);
}

const lines = raw
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l))
  .filter((line) => line.size_trajectory != null);

const have = lines.length;

if (have === 0) {
  console.log(
    `0 run(s) with size_trajectory logged yet for "${project}" -- nothing to check.`,
  );
  process.exit(0);
}

if (have < threshold) {
  console.log(
    `${have}/${threshold} passing run(s) with size_trajectory logged for "${project}" -- not enough yet.`,
  );
  process.exit(0);
}

console.log(
  `${have} passing run(s) with size_trajectory logged for "${project}" -- threshold (${threshold}) reached. Distribution:\n`,
);

const byTshirt = {};
const byDelta = {};
let scoreSum = 0;
let scoreMin = Infinity;
let scoreMax = -Infinity;

for (const line of lines) {
  const { step4_tshirt, delta, final_score } = line.size_trajectory;
  byTshirt[step4_tshirt] = (byTshirt[step4_tshirt] ?? 0) + 1;
  byDelta[delta] = (byDelta[delta] ?? 0) + 1;
  scoreSum += final_score;
  scoreMin = Math.min(scoreMin, final_score);
  scoreMax = Math.max(scoreMax, final_score);
}

console.log("By step4_tshirt:");
for (const [size, count] of Object.entries(byTshirt)) {
  console.log(`  ${size}: ${count}`);
}

console.log("By delta:");
for (const [delta, count] of Object.entries(byDelta)) {
  console.log(`  ${delta}: ${count}`);
}

console.log(
  `final_score: avg ${(scoreSum / have).toFixed(2)}, range ${scoreMin.toFixed(2)}-${scoreMax.toFixed(2)}`,
);

console.log(
  `\nThis is a one-off read, not a gate -- eyeball whether final_score's spread tracks step4_tshirt before deciding anything in docs/future-enhancements.md's size-score entry.`,
);
