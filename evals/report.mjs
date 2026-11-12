// Summarize eval records per scenario (ports poc-stacked-prs/harness/report.py's
// idea: aggregate only, no raw logs, no ticket text): outcome, phases,
// cost and minutes for each scenario's tickets.
//
//   node evals/report.mjs [--config=pipeline.eval.config.json] [--state=evals/.state]
//
// Reads runs/v2/<slug>.jsonl and <state>/scenarios (lines "<name> <K1[,K2]>",
// appended by run.sh); prints a Markdown table. Local only.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const minutesBetween = (a, b) => {
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? Math.round(ms / 60000) : null;
};

/** One row per (scenario, ticket): the ticket's latest record. Pure. */
export function summarize(records, scenarios) {
  const rows = [];
  for (const { scenario, keys } of scenarios) {
    for (const ticket of keys) {
      const rs = records.filter((r) => r.ticket === ticket);
      const rec = rs[rs.length - 1];
      if (!rec) {
        rows.push({ scenario, ticket, outcome: "no-record", phases: "", cost_usd: 0, minutes: null });
        continue;
      }
      const phases = rec.phases ?? [];
      rows.push({
        scenario,
        ticket,
        outcome: rec.outcome,
        phases: phases.map((p) => `${p.role}:${p.outcome}`).join(" "),
        cost_usd: Math.round(phases.reduce((s, p) => s + (Number(p.cost_usd) || 0), 0) * 100) / 100,
        minutes: phases.length > 0 ? minutesBetween(rec.started, rec.ended) : null,
      });
    }
  }
  return rows;
}

export function toMarkdown(rows) {
  const lines = ["| scenario | ticket | outcome | phases | cost $ | minutes |", "|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.scenario} | ${r.ticket} | ${r.outcome} | ${r.phases} | ${r.cost_usd} | ${r.minutes ?? ""} |`);
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  lines.push("", `Total cost: $${Math.round(total * 100) / 100}`);
  return lines.join("\n");
}

function isRunAsScript() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  const { parseFlags } = await import("../src/core/flags.ts");
  const flags = parseFlags(process.argv.slice(2), { values: ["--config", "--state"], bools: [] }, "report").values;
  const opt = (n, d) => flags[n] ?? d;
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const { loadConfig } = await import("../src/core/config.ts");
  const { readIterations } = await import("../src/core/iteration-log.ts");
  const { evalRunsLog } = await import("./config-guard.mjs");
  const config = await loadConfig(resolve(root, opt("--config", "pipeline.eval.config.json")));
  const records = await readIterations(resolve(root, evalRunsLog(config)));
  let scenarios = [];
  try {
    scenarios = readFileSync(resolve(root, opt("--state", "evals/.state"), "scenarios"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        const [scenario, csv = ""] = l.trim().split(/\s+/);
        return { scenario, keys: csv.split(",").filter(Boolean) };
      });
  } catch {
    // no scenarios recorded yet
  }
  console.log(toMarkdown(summarize(records, scenarios)));
}
