// The eval harness's Jira helper: the only code in evals/ that talks to
// Jira. Every call from a shell script goes through lib.sh's `jira`
// function, i.e. through `outward`, so DRY_RUN=1 never reaches it.
// Credentials come from JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN, which
// the caller loads with node --env-file (this file never reads a file).
//
//   node evals/jira.mjs auth
//   node evals/jira.mjs create --summary "[dev-loop-eval] ..." --description-file <f> [--trigger]   -> prints the key
//   node evals/jira.mjs link-blocks <BLOCKER> <BLOCKED>       (BLOCKED "is blocked by" BLOCKER)
//   node evals/jira.mjs get <KEY>                              -> prints {key,status,labels,summary}
//   node evals/jira.mjs wait-searchable <KEY>...               (blocks until JQL search finds every key)
//   node evals/jira.mjs eligible <KEY>                         -> exit 0 iff label + summary prefix both hold
//   node evals/jira.mjs close <KEY>                            (eligible keys only)
//
// Every write refuses a ticket that is not an eval ticket: creates must
// carry the summary prefix (and get the eval label); link and close check
// both label and prefix on the live ticket first.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redactSensitive } from "../src/core/redact.ts";

export const EVAL_LABEL = "dev-loop-eval";
export const EVAL_PREFIX = "[dev-loop-eval]";
export const PROJECT_KEY = "TARS";
/** Labels every eval ticket carries. The trigger label is added only to tickets the loop should pick up. */
export const BASE_LABELS = ["repo:dev-loop-eval", EVAL_LABEL];
export const TRIGGER_LABEL = "pipeline:v2";
/**
 * TARS's Story Points field. The To Do -> In Progress claim is refused
 * without it ("Field Story Points is required.", seen on TARS-1631), so every
 * eval ticket is created with EVAL_STORY_POINTS.
 */
export const STORY_POINTS_FIELD = "customfield_10002";
export const EVAL_STORY_POINTS = 1;
/** TARS requires every Task to sit under an Epic; eval tickets go under this one. */
export const EVAL_EPIC = "TARS-1384";
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

/** Pure: is this ticket one the harness may write to? */
export function isEvalTicket(t) {
  return Array.isArray(t?.labels) && t.labels.includes(EVAL_LABEL) && typeof t?.summary === "string" && t.summary.startsWith(EVAL_PREFIX);
}

function creds() {
  const { JIRA_BASE_URL: base, JIRA_EMAIL: email, JIRA_API_TOKEN: token } = process.env;
  if (!base || !email || !token) throw new Error("JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN not set (load them with --env-file)");
  return { base: base.replace(/\/+$/, ""), auth: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
}

async function request(path, init = {}) {
  const { base, auth } = creds();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = jiraErrorDetail(await res.text().catch(() => ""));
    throw new Error(`Jira ${init.method ?? "GET"} ${path}: ${res.status} ${res.statusText}${detail ? ` (${detail})` : ""}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Jira's own reasons from an error body (errorMessages + per-field errors), redacted. Pure. */
export function jiraErrorDetail(text) {
  let out = "";
  try {
    const j = JSON.parse(text);
    const parts = [...(Array.isArray(j?.errorMessages) ? j.errorMessages : []), ...Object.entries(j?.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
    out = parts.join("; ");
  } catch {
    out = String(text ?? "");
  }
  return redactSensitive(out).slice(0, 200);
}

function checkKey(key) {
  if (typeof key !== "string" || !KEY_RE.test(key)) throw new Error(`not a ticket key: ${JSON.stringify(key)}`);
  return key;
}

export async function getTicket(key) {
  const data = await request(`/rest/api/3/issue/${checkKey(key)}?fields=status,labels,summary`);
  return { key, status: data.fields.status?.name ?? null, labels: data.fields.labels ?? [], summary: data.fields.summary ?? "" };
}

/**
 * Waits until Jira's JQL search finds every key. A new ticket takes ~30s to
 * become searchable (2026-11-17: TARS-1638/1639), and the loop finds work only
 * by search, so a run started at once sees "nothing to do". `deps` is injected
 * in tests.
 */
export async function waitSearchable(keys, deps = {}) {
  for (const k of keys) checkKey(k);
  const search = deps.search ?? (async (jql) => {
    const data = await request("/rest/api/3/search/jql", { method: "POST", body: JSON.stringify({ jql, fields: ["summary"], maxResults: keys.length }) });
    return (data?.issues ?? []).map((i) => i.key);
  });
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? 5 * 60_000;
  const stepMs = deps.stepMs ?? 5000;
  const jql = `key in (${keys.join(", ")})`;
  const start = now();
  for (let tries = 1; ; tries++) {
    const found = new Set(await search(jql));
    const missing = keys.filter((k) => !found.has(k));
    if (missing.length === 0) return tries;
    if (now() - start >= timeoutMs) {
      throw new Error(`Jira search still does not find ${missing.join(", ")} after ${Math.round(timeoutMs / 1000)}s (new tickets take ~30s to be searchable)`);
    }
    await sleep(stepMs);
  }
}

async function requireEval(key) {
  const t = await getTicket(key);
  if (!isEvalTicket(t)) throw new Error(`${key} is not an eval ticket (needs label ${EVAL_LABEL} and summary prefix ${EVAL_PREFIX}); refusing`);
  return t;
}

const adf = (text) => ({
  type: "doc",
  version: 1,
  content: text.split(/\n{2,}/).map((para) => ({ type: "paragraph", content: [{ type: "text", text: para }] })),
});

/** The POST /rest/api/3/issue body for an eval ticket. Pure. */
export function createIssueBody(summary, description, trigger) {
  if (typeof summary !== "string" || !summary.startsWith(EVAL_PREFIX)) throw new Error(`summary must start with ${EVAL_PREFIX}`);
  const labels = trigger ? [...BASE_LABELS, TRIGGER_LABEL] : [...BASE_LABELS];
  return {
    fields: {
      project: { key: PROJECT_KEY },
      issuetype: { name: "Task" },
      parent: { key: EVAL_EPIC },
      summary,
      labels,
      description: adf(description),
      [STORY_POINTS_FIELD]: EVAL_STORY_POINTS,
    },
  };
}

async function create(summary, description, trigger) {
  const data = await request("/rest/api/3/issue", { method: "POST", body: JSON.stringify(createIssueBody(summary, description, trigger)) });
  return checkKey(data.key);
}

async function linkBlocks(blocker, blocked) {
  await requireEval(blocker);
  await requireEval(blocked);
  await request("/rest/api/3/issueLink", {
    method: "POST",
    body: JSON.stringify({ type: { name: "Blocks" }, inwardIssue: { key: blocker }, outwardIssue: { key: blocked } }),
  });
}

/**
 * The label update that strips every pipeline:* label, or null when there is
 * none. A closed ticket still labelled pipeline:v2:dev was run again by dev
 * (TARS-1640, 2026-11-17). Pure.
 */
export function closeLabelUpdate(labels) {
  const remove = labels.filter((l) => l.startsWith("pipeline:"));
  return remove.length === 0 ? null : { update: { labels: remove.map((l) => ({ remove: l })) } };
}

async function close(key) {
  const ticket = await requireEval(key);
  const strip = closeLabelUpdate(ticket.labels);
  if (strip) await request(`/rest/api/3/issue/${key}`, { method: "PUT", body: JSON.stringify(strip) });
  const data = await request(`/rest/api/3/issue/${key}/transitions`);
  const t = (data.transitions ?? []).find((x) => x.to?.statusCategory?.key === "done");
  if (!t) throw new Error(`${key}: no done-category transition available`);
  await request(`/rest/api/3/issue/${key}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: t.id } }) });
}


function isRunAsScript() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "auth":
        await request("/rest/api/3/myself");
        console.error("[eval] Jira auth OK");
        break;
      case "create": {
        const { parseFlags } = await import("../src/core/flags.ts");
        const { values, bools } = parseFlags(args, { values: ["--summary", "--description-file"], bools: ["--trigger"] }, "jira create");
        const summary = values["--summary"];
        const file = values["--description-file"];
        if (!summary || !file) throw new Error("create needs --summary=<text> and --description-file=<path>");
        console.log(await create(summary, readFileSync(file, "utf8"), bools.has("--trigger")));
        break;
      }
      case "wait-searchable": {
        const tries = await waitSearchable(args);
        console.error(`[eval] Jira search finds ${args.join(", ")}${tries > 1 ? ` (after ${tries} tries)` : ""}`);
        break;
      }
      case "link-blocks":
        await linkBlocks(checkKey(args[0]), checkKey(args[1]));
        break;
      case "get":
        console.log(JSON.stringify(await getTicket(args[0])));
        break;
      case "eligible":
        process.exit(isEvalTicket(await getTicket(args[0])) ? 0 : 1);
        break;
      case "close":
        await close(checkKey(args[0]));
        break;
      default:
        throw new Error(`unknown command ${JSON.stringify(cmd)}`);
    }
  } catch (err) {
    console.error(`[eval] jira: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
