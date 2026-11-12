// Scenario `blocked` grader: the ticket is blocked by a ticket with an open
// sandbox PR; its record is `skipped-blocked` naming that blocker, there
// was no claim (no record with a phase run, no claim-error), and its Jira
// status is still To Do.
//
//   pr:   the blocker's sandbox PR (must still be OPEN, or the setup did not hold)
//   jira: { key, status, blocker }
//
// CLI (gathers real state; run by evals/run.sh): node evals/check-blocked.mjs --keys <KEY> --blocker <KEY>

import { CLAIM_FROM_STATUS, expectStatus, forKey, result } from "./grade-lib.mjs";
import { runGraderCli } from "./gather.mjs";

export function grade({ records, pr, jira }) {
  const reasons = [];
  const key = jira?.key;
  const rs = forKey(records, key);
  const skips = rs.filter((r) => r.outcome === "skipped-blocked");
  if (skips.length === 0) reasons.push(`no skipped-blocked record for ${key}`);
  else if (!skips.some((r) => (r.blocked_by ?? []).includes(jira?.blocker))) {
    reasons.push(`${key}: no skipped-blocked record names blocker ${jira?.blocker} (blocked_by: ${JSON.stringify(skips.map((r) => r.blocked_by))})`);
  }
  const claimed = rs.filter((r) => r.outcome !== "skipped-blocked" || (r.phases ?? []).length > 0);
  if (claimed.length > 0) {
    reasons.push(`${key}: a claim happened (records: ${claimed.map((r) => r.outcome).join(", ")})`);
  }
  expectStatus(reasons, jira, CLAIM_FROM_STATUS);
  if (!pr) reasons.push(`blocker ${jira?.blocker} has no sandbox PR (the setup did not hold)`);
  else if (pr.state !== "OPEN") reasons.push(`blocker PR ${pr.url} is ${pr.state}, want OPEN (the setup did not hold)`);
  return result(reasons);
}

await runGraderCli(import.meta.url, "blocked", grade);
