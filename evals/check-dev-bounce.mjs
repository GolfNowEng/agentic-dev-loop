// Scenario `dev-bounce` grader: research landed, dev bounced with
// failure_category `spec_ambiguous`, the ticket is in Blocked, and no
// sandbox PR exists (a dev run that opened one and then bounced fails).
//
//   jira: { key, status }
//
// CLI (gathers real state; run by evals/run.sh): node evals/check-dev-bounce.mjs --keys=<KEY>

import { BOUNCED_STATUS, expectNoPr, expectOutcome, expectPhases, expectStatus, latest, result } from "./grade-lib.mjs";
import { runGraderCli } from "./gather.mjs";

export function grade({ records, pr, jira }) {
  const reasons = [];
  const rec = latest(records, jira?.key);
  if (expectOutcome(reasons, rec, jira?.key, "bounced")) {
    expectPhases(reasons, rec, ["research:landed", "dev:bounced"]);
    const dev = (rec.phases ?? []).find((p) => p.role === "dev");
    if (dev && dev.failure_category !== "spec_ambiguous") {
      reasons.push(`${rec.ticket}: dev failure_category is ${JSON.stringify(dev.failure_category)}, want spec_ambiguous`);
    }
  }
  expectStatus(reasons, jira, BOUNCED_STATUS);
  expectNoPr(reasons, pr);
  return result(reasons);
}

await runGraderCli(import.meta.url, "dev-bounce", grade);
