// Shared pieces of the eval graders (evals/check-*.mjs). Pure: no I/O.
//
// A grader is `grade({ records, pr, jira }) -> { pass, reasons }` where
//   records  the v2 iteration records (src/core/iteration-log.ts
//            IterationRecord) from runs/v2/<slug>.jsonl, in file order;
//   pr       the sandbox PR the scenario is about, or null:
//            { url, state: "OPEN"|"CLOSED"|"MERGED", commits: [{ headline }] }
//            (commits oldest first, as `gh pr view --json commits` gives);
//   jira     the ticket state the grader needs (per grader).
// `reasons` lists every failed expectation; pass === (reasons.length === 0).

export const BOUNCED_STATUS = "Blocked";
export const CLAIM_FROM_STATUS = "To Do";

export function forKey(records, key) {
  return (records ?? []).filter((r) => r && r.ticket === key);
}

/** The ticket's latest record (file order is append order), or null. */
export function latest(records, key) {
  const rs = forKey(records, key);
  return rs.length > 0 ? rs[rs.length - 1] : null;
}

export function result(reasons) {
  return { pass: reasons.length === 0, reasons };
}

export function expectOutcome(reasons, rec, key, outcome) {
  if (!rec) {
    reasons.push(`no record for ${key}`);
    return false;
  }
  if (rec.outcome !== outcome) reasons.push(`${key}: record outcome is ${rec.outcome}, want ${outcome}`);
  return true;
}

export function expectPhases(reasons, rec, want) {
  const got = (rec.phases ?? []).map((p) => `${p.role}:${p.outcome}`);
  if (got.length !== want.length) {
    reasons.push(`${rec.ticket}: ${got.length} phases (${got.join(", ") || "none"}), want ${want.length} phases (${want.join(", ")})`);
    return;
  }
  want.forEach((w, i) => {
    if (got[i] !== w) reasons.push(`${rec.ticket}: phase ${i + 1} is ${got[i]}, want ${w}`);
  });
}

export function expectStatus(reasons, jira, want) {
  if (jira?.status !== want) reasons.push(`${jira?.key ?? "ticket"}: Jira status is ${JSON.stringify(jira?.status)}, want ${want}`);
}

export function expectNoPr(reasons, pr) {
  if (pr) reasons.push(`a sandbox PR exists (${pr.url}, ${pr.state}); this scenario must not open one`);
}

const isRed = (headline) => /^test(\([^)]*\))?!?:/.test(headline ?? "");

/** The PR is open, is the one the dev phase recorded, and its first RED (test:) commit precedes its first GREEN commit. */
export function expectOpenTddPr(reasons, rec, pr) {
  if (!pr) {
    reasons.push("no sandbox PR found");
    return;
  }
  if (pr.state !== "OPEN") reasons.push(`sandbox PR ${pr.url} is ${pr.state}, want OPEN`);
  const devPr = (rec?.phases ?? []).find((p) => p.role === "dev")?.pr ?? null;
  if (devPr !== pr.url) reasons.push(`the dev phase recorded PR ${JSON.stringify(devPr)}, but the graded PR is ${pr.url}`);
  const heads = (pr.commits ?? []).map((c) => c.headline ?? "");
  const red = heads.findIndex(isRed);
  const green = heads.findIndex((h) => !isRed(h));
  if (red === -1) reasons.push("no RED commit (test: ...) on the PR");
  if (green === -1) reasons.push("no GREEN commit (non-test) on the PR");
  if (red !== -1 && green !== -1 && red > green) {
    reasons.push(`RED commit "${heads[red]}" comes after GREEN commit "${heads[green]}"`);
  }
}
