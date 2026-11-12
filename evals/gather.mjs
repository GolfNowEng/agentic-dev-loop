// The thin CLI wrapper around a pure grader: gathers the real state (the
// eval runs log, the sandbox PR via gh, the Jira ticket via jira.mjs),
// calls grade(), prints the result and exits 0 on pass, 1 on fail. Only
// runs when a check-*.mjs is executed directly, which evals/run.sh does
// through `outward` (so never in DRY_RUN=1, and never in the tests, which
// import the graders).
//
//   node --env-file=<env> evals/check-<name>.mjs --keys <K1[,K2]> [--blocker <K>] [--config <path>]

import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const SANDBOX = "JustinChan-fd/dev-loop-eval-sandbox";

function isMain(metaUrl) {
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}

function flag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** The sandbox PR whose head branch starts with the key (newest), or null. */
function sandboxPr(key) {
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
  const list = JSON.parse(gh(["pr", "list", "--repo", SANDBOX, "--state", "all", "--search", key, "--json", "number,headRefName"]));
  const hit = list.find((p) => p.headRefName === key || p.headRefName.startsWith(`${key}-`));
  if (!hit) return null;
  const pr = JSON.parse(gh(["pr", "view", String(hit.number), "--repo", SANDBOX, "--json", "url,state,commits"]));
  return { url: pr.url, state: pr.state, commits: (pr.commits ?? []).map((c) => ({ headline: c.messageHeadline })) };
}

export async function runGraderCli(metaUrl, name, grade) {
  if (!isMain(metaUrl)) return;
  const root = resolve(fileURLToPath(metaUrl), "../..");
  const { loadConfig } = await import("../src/core/config.ts");
  const { readIterations } = await import("../src/core/iteration-log.ts");
  const { getTicket } = await import("./jira.mjs");
  const { evalRunsLog } = await import("./config-guard.mjs");

  const keys = (flag("--keys") ?? "").split(",").filter(Boolean);
  if (keys.length === 0) {
    console.error(`usage: node evals/check-${name}.mjs --keys <K1[,K2]> [--blocker <K>]`);
    process.exit(2);
  }
  const config = await loadConfig(resolve(root, flag("--config") ?? "pipeline.eval.config.json"));
  const records = await readIterations(resolve(root, evalRunsLog(config)));

  let pr;
  let jira;
  if (name === "queue") {
    pr = sandboxPr(keys[1]);
    jira = { keys };
  } else if (name === "blocked") {
    const blocker = flag("--blocker");
    pr = blocker ? sandboxPr(blocker) : null;
    jira = { ...(await getTicket(keys[0])), blocker };
  } else {
    pr = sandboxPr(keys[0]);
    jira = await getTicket(keys[0]);
  }

  const r = grade({ records, pr, jira });
  console.log(JSON.stringify({ scenario: name, keys, ...r }));
  process.exit(r.pass ? 0 : 1);
}
