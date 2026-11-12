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
//   node evals/jira.mjs eligible <KEY>                         -> exit 0 iff label + summary prefix both hold
//   node evals/jira.mjs close <KEY>                            (eligible keys only)
//
// Every write refuses a ticket that is not an eval ticket: creates must
// carry the summary prefix (and get the eval label); link and close check
// both label and prefix on the live ticket first.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EVAL_LABEL = "dev-loop-eval";
export const EVAL_PREFIX = "[dev-loop-eval]";
export const PROJECT_KEY = "TARS";
/** Labels every eval ticket carries. The trigger label is added only to tickets the loop should pick up. */
export const BASE_LABELS = ["repo:webtarsthree", EVAL_LABEL];
export const TRIGGER_LABEL = "pipeline:v2.0.0";
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
  if (!res.ok) throw new Error(`Jira ${init.method ?? "GET"} ${path}: ${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

function checkKey(key) {
  if (typeof key !== "string" || !KEY_RE.test(key)) throw new Error(`not a ticket key: ${JSON.stringify(key)}`);
  return key;
}

export async function getTicket(key) {
  const data = await request(`/rest/api/3/issue/${checkKey(key)}?fields=status,labels,summary`);
  return { key, status: data.fields.status?.name ?? null, labels: data.fields.labels ?? [], summary: data.fields.summary ?? "" };
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

async function create(summary, description, trigger) {
  if (!summary.startsWith(EVAL_PREFIX)) throw new Error(`summary must start with ${EVAL_PREFIX}`);
  const labels = trigger ? [...BASE_LABELS, TRIGGER_LABEL] : BASE_LABELS;
  const data = await request("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({ fields: { project: { key: PROJECT_KEY }, issuetype: { name: "Task" }, summary, labels, description: adf(description) } }),
  });
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

async function close(key) {
  await requireEval(key);
  const data = await request(`/rest/api/3/issue/${key}/transitions`);
  const t = (data.transitions ?? []).find((x) => x.to?.statusCategory?.key === "done");
  if (!t) throw new Error(`${key}: no done-category transition available`);
  await request(`/rest/api/3/issue/${key}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: t.id } }) });
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
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
        const summary = flag(args, "--summary");
        const file = flag(args, "--description-file");
        if (!summary || !file) throw new Error("create needs --summary and --description-file");
        console.log(await create(summary, readFileSync(file, "utf8"), args.includes("--trigger")));
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
