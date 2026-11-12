// Scenario `ambiguous` grader: research `bounced` (1 phase), the ticket is
// in Blocked, and no sandbox PR was opened.
//
//   jira: { key, status }
//
// CLI (gathers real state; run by evals/run.sh): node evals/check-ambiguous.mjs --keys <KEY>

import { BOUNCED_STATUS, expectNoPr, expectOutcome, expectPhases, expectStatus, latest, result } from "./grade-lib.mjs";
import { runGraderCli } from "./gather.mjs";

export function grade({ records, pr, jira }) {
  const reasons = [];
  const rec = latest(records, jira?.key);
  if (expectOutcome(reasons, rec, jira?.key, "bounced")) expectPhases(reasons, rec, ["research:bounced"]);
  expectStatus(reasons, jira, BOUNCED_STATUS);
  expectNoPr(reasons, pr);
  return result(reasons);
}

await runGraderCli(import.meta.url, "ambiguous", grade);
