// Scenario `clean` grader: the record is `landed` with 2 phases
// (research landed, dev landed), and the sandbox PR is open with the RED
// commit before GREEN.
//
//   jira: { key, status }
//
// CLI (gathers real state; run by evals/run.sh): node evals/check-clean.mjs --keys=<KEY>

import { expectOpenTddPr, expectOutcome, expectPhases, latest, result } from "./grade-lib.mjs";
import { runGraderCli } from "./gather.mjs";

export function grade({ records, pr, jira }) {
  const reasons = [];
  const rec = latest(records, jira?.key);
  if (expectOutcome(reasons, rec, jira?.key, "landed")) {
    expectPhases(reasons, rec, ["research:landed", "dev:landed"]);
    expectOpenTddPr(reasons, rec, pr);
  }
  return result(reasons);
}

await runGraderCli(import.meta.url, "clean", grade);
