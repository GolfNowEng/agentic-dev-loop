// Scenario `queue` grader: two tickets, the first ambiguous and the second
// clean, worked in order: exactly two records for them, the first
// `bounced`, the second `landed` (with the second ticket's sandbox PR open).
//
//   pr:   the second ticket's sandbox PR
//   jira: { keys: [first, second] }
//
// CLI (gathers real state; run by evals/run.sh): node evals/check-queue.mjs --keys=<FIRST>,<SECOND>

import { result } from "./grade-lib.mjs";
import { runGraderCli } from "./gather.mjs";

export function grade({ records, pr, jira }) {
  const reasons = [];
  const [first, second] = jira?.keys ?? [];
  const rs = (records ?? []).filter((r) => r && (r.ticket === first || r.ticket === second));
  if (rs.length !== 2) {
    reasons.push(`${rs.length} records for ${first}, ${second} (${rs.map((r) => `${r.ticket}:${r.outcome}`).join(", ") || "none"}), want 2 records`);
  }
  if (rs[0] && rs[0].ticket !== first) reasons.push(`the first record is for ${rs[0].ticket}, want ${first} (worked out of order)`);
  if (rs[0] && rs[0].ticket === first && rs[0].outcome !== "bounced") reasons.push(`${first}: outcome ${rs[0].outcome}, want bounced`);
  const second_ = rs.find((r) => r.ticket === second);
  if (!second_) reasons.push(`no record for ${second}`);
  else if (second_.outcome !== "landed") reasons.push(`${second}: outcome ${second_.outcome}, want landed`);
  if (second_?.outcome === "landed" && pr?.state !== "OPEN") reasons.push(`${second}: its sandbox PR is not open (${pr ? pr.state : "none"})`);
  return result(reasons);
}

await runGraderCli(import.meta.url, "queue", grade);
