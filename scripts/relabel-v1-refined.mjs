// Cutover step: find tickets research-loop refined but never promoted, and
// (with --write) add the project's dev trigger label so v1 dev-loop picks
// them up. Dry run by default; never removes labels.
//   node --env-file=.env scripts/relabel-v1-refined.mjs --project <p> [--write --confirm <sha256>]
// Env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_ASSIGNEE_ACCOUNT_ID.
// Test seams: --root (where pipeline.<p>.config.json lives), CUTOVER_PGREP.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function parse(argv) {
  const o = { write: false, root: resolve(import.meta.dirname, "..") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") o.write = true;
    else if (a === "--project" || a === "--confirm" || a === "--root") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = a === "--root" ? resolve(v) : v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.project) throw new Error("usage: --project <name> [--write --confirm <sha256>]");
  return o;
}

function runningLoops() {
  try {
    const out = execFileSync(process.env.CUTOVER_PGREP || "pgrep", ["-fl", "src/main.ts"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.trim() && !l.includes("relabel-v1-refined"));
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}

function adfText(node) {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(adfText).join(node.type === "doc" ? "\n" : "");
}

const RESEARCH = /^(?:## )?(✅|❌) research-loop -/;

async function main() {
  const o = parse(process.argv.slice(2));
  const need = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_ASSIGNEE_ACCOUNT_ID"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env var(s): ${missing.join(", ")}`);
  const cfg = JSON.parse(readFileSync(resolve(o.root, `pipeline.${o.project}.config.json`), "utf8"));
  const repoLabel = cfg.jira?.repoLabel;
  const devLabel = cfg.roles?.dev?.triggerLabel;
  if (!repoLabel || !devLabel) throw new Error("config lacks jira.repoLabel or roles.dev.triggerLabel");

  const base = process.env.JIRA_BASE_URL.replace(/\/$/, "");
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64");
  const call = async (path, init = {}) => {
    const r = await fetch(base + path, {
      ...init,
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/json" },
    });
    if (!r.ok) throw new Error(`Jira ${init.method ?? "GET"} ${path} failed: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };

  const jql = `labels = "pipeline:research" AND labels = "${repoLabel}" AND status = "In Progress"`;
  const issues = [];
  let token;
  do {
    const page = await call("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({ jql, fields: ["labels"], maxResults: 100, ...(token ? { nextPageToken: token } : {}) }),
    });
    issues.push(...page.issues);
    token = page.nextPageToken;
  } while (token);

  const selected = [];
  for (const issue of issues) {
    const comments = [];
    for (let startAt = 0; ; ) {
      const page = await call(`/rest/api/3/issue/${issue.key}/comment?startAt=${startAt}&maxResults=100`);
      comments.push(...page.comments);
      startAt += page.comments.length;
      if (page.comments.length === 0 || startAt >= page.total) break;
    }
    const research = comments
      .map((c) => ({ c, m: RESEARCH.exec(adfText(c.body).trim()) }))
      .filter((x) => x.m)
      .sort((a, b) => Date.parse(a.c.created) - Date.parse(b.c.created));
    const latest = research.at(-1);
    if (latest && latest.m[1] === "✅" && latest.c.author?.accountId === process.env.JIRA_ASSIGNEE_ACCOUNT_ID)
      selected.push({ key: issue.key, labels: issue.fields.labels ?? [] });
  }
  selected.sort((a, b) => (a.key < b.key ? -1 : 1));

  if (selected.length === 0) {
    console.log("No tickets selected.");
    return;
  }
  const hash = createHash("sha256").update(selected.map((s) => s.key).join("\n")).digest("hex");
  for (const s of selected) console.log(`${s.key}  labels: ${s.labels.join(", ")}  -> add: ${devLabel}`);
  console.log(`sha256: ${hash}`);
  if (!o.write) return;

  if (o.confirm !== hash) throw new Error("Refusing: --write needs --confirm <sha256 from the dry run> (missing or mismatched)");
  const loops = runningLoops();
  if (loops.length) throw new Error(`Refusing: a loop process (src/main.ts) is running:\n${loops.join("\n")}`);
  for (const s of selected) {
    await call(`/rest/api/3/issue/${s.key}`, {
      method: "PUT",
      body: JSON.stringify({ update: { labels: [{ add: devLabel }] } }),
    });
    console.log(`labeled ${s.key}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
