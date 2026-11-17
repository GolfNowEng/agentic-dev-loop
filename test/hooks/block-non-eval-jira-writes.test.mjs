// End-to-end test of .claude/hooks/block-non-eval-jira-writes.sh, driven
// via real piped stdin JSON the same shape Claude Code sends a PreToolUse
// hook. The hook is the eval boundary (Task 16, spec §9.2): active only
// when DEVLOOP_EVAL_KEYS is set, it then denies any Jira write whose issue
// key is not an eval key. Run with:
//   npm run test:hooks
//   node test/hooks/block-non-eval-jira-writes.test.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, BROKEN_CHECKER, runHook, withTempLayout, withOutsideCwd, check, finish } from "./_helpers.mjs";

const HOOK = "block-non-eval-jira-writes.sh";
const KEYS = "TARS-9001,TARS-9002";
const ON = { DEVLOOP_EVAL_KEYS: KEYS };
const OFF = { DEVLOOP_EVAL_KEYS: undefined };
const run = (stdin, env = ON, opts = {}) => runHook(HOOK, stdin, { env, ...opts });
const mcp = (name, tool_input) => JSON.stringify({ tool_name: `mcp__atlassian__${name}`, tool_input });

const WRITES = [
  ["addCommentToJiraIssue", { issueIdOrKey: "TARS-1", commentBody: "x" }],
  ["editJiraIssue", { issueIdOrKey: "TARS-1", fields: { summary: "x" } }],
  ["transitionJiraIssue", { issueIdOrKey: "TARS-1", transition: { id: "31" } }],
  ["addWorklogToJiraIssue", { issueIdOrKey: "TARS-1", timeSpent: "1h" }],
  ["createIssueLink", { inwardIssue: "TARS-1", outwardIssue: "TARS-2", type: "Blocks" }],
  ["createJiraIssue", { projectKey: "TARS", issueTypeName: "Task", summary: "not eval" }],
];

// Unset: inactive, everything allowed (including malformed input).
{
  for (const [name, input] of WRITES) {
    const r = run(mcp(name, input), OFF);
    check(`unset: ${name} on a foreign key allowed`, r.status === 0, `got ${r.status}, stderr: ${r.stderr}`);
  }
  const r = run("{not json", OFF);
  check("unset: malformed JSON allowed (hook inactive)", r.status === 0, `got ${r.status}`);
}

// Set: listed key writes allowed.
for (const name of ["addCommentToJiraIssue", "editJiraIssue", "transitionJiraIssue", "addWorklogToJiraIssue"]) {
  const r = run(mcp(name, { issueIdOrKey: "TARS-9001", x: 1 }));
  check(`set: ${name} on a listed key allowed`, r.status === 0, `got ${r.status}, stderr: ${r.stderr}`);
}
{
  const r = run(mcp("editJiraIssue", { issueKey: "TARS-9002", fields: {} }));
  check("set: issueKey (not issueIdOrKey) on a listed key allowed", r.status === 0, `got ${r.status}, stderr: ${r.stderr}`);
}

// Set: other key denied, every write tool.
for (const [name, input] of WRITES) {
  const r = run(mcp(name, input));
  check(`set: ${name} on a foreign key denied`, r.status === 2, `got ${r.status}`);
  check(`set: ${name} denial names the boundary`, r.stderr.includes("DEVLOOP_EVAL_KEYS"), r.stderr);
}

// A key that is a prefix/suffix of a listed one is not listed.
{
  const r = run(mcp("addCommentToJiraIssue", { issueIdOrKey: "TARS-900", commentBody: "x" }));
  check("set: TARS-900 is not TARS-9001", r.status === 2, `got ${r.status}`);
  const r2 = run(mcp("addCommentToJiraIssue", { issueIdOrKey: "TARS-90011", commentBody: "x" }));
  check("set: TARS-90011 is not TARS-9001", r2.status === 2, `got ${r2.status}`);
}

// A write with no key at all is denied.
{
  const r = run(mcp("addCommentToJiraIssue", { commentBody: "x" }));
  check("set: write with no issue key denied", r.status === 2, `got ${r.status}`);
}

// Links: both ends must be listed.
{
  const both = run(mcp("createIssueLink", { inwardIssue: "TARS-9002", outwardIssue: "TARS-9001", type: "Blocks" }));
  check("set: link with both ends listed allowed", both.status === 0, `got ${both.status}, stderr: ${both.stderr}`);
  const inward = run(mcp("createIssueLink", { inwardIssue: "TARS-1", outwardIssue: "TARS-9001", type: "Blocks" }));
  check("set: link with a foreign inward end denied", inward.status === 2, `got ${inward.status}`);
  const outward = run(mcp("createIssueLink", { inwardIssue: "TARS-9001", outwardIssue: "TARS-1", type: "Blocks" }));
  check("set: link with a foreign outward end denied", outward.status === 2, `got ${outward.status}`);
}

// createJiraIssue: allowed only when ALL hold: project TARS, the
// [dev-loop-eval] summary prefix, the dev-loop-eval label, no parent (or a
// listed one), and no transition.
{
  const GOOD = {
    cloudId: "x",
    projectKey: "TARS",
    issueTypeName: "Task",
    summary: "[dev-loop-eval] follow-up",
    additional_fields: { labels: ["repo:webtarsthree", "dev-loop-eval"] },
  };
  const create = (patch) => run(mcp("createJiraIssue", { ...GOOD, ...patch }));
  const allow = (name, r) => check(`set: createJiraIssue ${name} allowed`, r.status === 0, `got ${r.status}, stderr: ${r.stderr}`);
  const deny = (name, r) => check(`set: createJiraIssue ${name} denied`, r.status === 2, `got ${r.status}`);

  allow("with project, prefix and label", create({}));
  allow("with a listed parent", create({ issueTypeName: "Sub-task", parent: "TARS-9001" }));
  allow("with project in additional_fields.project", create({ projectKey: undefined, additional_fields: { ...GOOD.additional_fields, project: { key: "TARS" } } }));

  deny("with the prefix not at the start", create({ summary: "follow-up [dev-loop-eval]" }));
  deny("with no summary", create({ summary: undefined }));
  deny("in another project", create({ projectKey: "MC" }));
  deny("with no project", create({ projectKey: undefined }));
  deny("with projectKey TARS but additional_fields.project elsewhere", create({ additional_fields: { ...GOOD.additional_fields, project: { key: "MC" } } }));
  deny("without the dev-loop-eval label", create({ additional_fields: { labels: ["repo:webtarsthree"] } }));
  deny("with no labels at all", create({ additional_fields: undefined }));
  deny("with labels not an array", create({ additional_fields: { labels: "dev-loop-eval" } }));
  deny("with a foreign parent", create({ issueTypeName: "Sub-task", parent: "TARS-1381" }));
  deny("with a parent in additional_fields", create({ additional_fields: { ...GOOD.additional_fields, parent: { key: "TARS-1381" } } }));
  deny("with a transition", create({ transition: { id: "31" } }));
  deny("with a transition even when empty", create({ transition: {} }));
}

// Reads always allowed, even on foreign keys.
for (const [name, input] of [
  ["getJiraIssue", { issueIdOrKey: "TARS-1" }],
  ["searchJiraIssuesUsingJql", { jql: "project = TARS" }],
  ["getTransitionsForJiraIssue", { issueIdOrKey: "TARS-1" }],
  ["getJiraIssueRemoteIssueLinks", { issueIdOrKey: "TARS-1" }],
  ["lookupJiraAccountId", { searchString: "x" }],
  ["atlassianUserInfo", {}],
  ["fetch", { id: "x" }],
]) {
  const r = run(mcp(name, input));
  check(`set: read ${name} allowed`, r.status === 0, `got ${r.status}, stderr: ${r.stderr}`);
}

// Unknown or Confluence atlassian writes fail closed while active.
{
  const r = run(mcp("createConfluencePage", { spaceId: "1", title: "x" }));
  check("set: Confluence write denied", r.status === 2, `got ${r.status}`);
  const u = run(mcp("someFutureWrite", { issueIdOrKey: "TARS-9001" }));
  check("set: unknown atlassian tool denied", u.status === 2, `got ${u.status}`);
}

// Non-atlassian tools are not this hook's business.
{
  const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" } }));
  check("set: Bash allowed", r.status === 0, `got ${r.status}`);
}

// Malformed input fails closed while active.
{
  const r = run("{not json");
  check("set: malformed JSON denied", r.status === 2, `got ${r.status}`);
  const empty = run("");
  check("set: empty stdin denied", empty.status === 2, `got ${empty.status}`);
  const noInput = run(JSON.stringify({ tool_name: "mcp__atlassian__editJiraIssue" }));
  check("set: write with no tool_input denied", noInput.status === 2, `got ${noInput.status}`);
}

// The sbx gateway's server name and Atlassian's v2 tool names get the same rules.
{
  const gw = (name, tool_input) => JSON.stringify({ tool_name: `mcp__mcp-gateway__${name}`, tool_input });
  const own = run(gw("addOrEditJiraIssueComment", { issueIdOrKey: "TARS-9001", commentBody: "x" }));
  check("gateway: v2 comment on an eval key allowed", own.status === 0, `got ${own.status}, stderr: ${own.stderr}`);
  const foreign = run(gw("addOrEditJiraIssueComment", { issueIdOrKey: "TARS-1", commentBody: "x" }));
  check("gateway: v2 comment on a foreign key denied", foreign.status === 2, `got ${foreign.status}`);
  const edit = run(gw("editJiraIssue", { issueIdOrKey: "TARS-1", fields: {} }));
  check("gateway: edit on a foreign key denied", edit.status === 2, `got ${edit.status}`);
  for (const name of ["getJiraIssue", "listJiraIssueComments", "getConfluenceContent", "searchConfluence"]) {
    const r = run(gw(name, { issueIdOrKey: "TARS-1" }));
    check(`gateway: read ${name} allowed`, r.status === 0, `got ${r.status}, stderr: ${r.stderr}`);
  }
  for (const name of ["executeWrite", "executeDestructive", "createConfluenceContent", "someFutureTool"]) {
    const r = run(gw(name, { name: "x" }));
    check(`gateway: ${name} denied (unknown or generic write)`, r.status === 2, `got ${r.status}`);
  }
  const other = run(JSON.stringify({ tool_name: "mcp__datadog__search_logs", tool_input: { q: "x" } }));
  check("set: a non-Atlassian MCP server is not this hook's business", other.status === 0, `got ${other.status}`);
}

// Set but empty: active with no keys, so every keyed write is denied.
{
  const r = run(mcp("addCommentToJiraIssue", { issueIdOrKey: "TARS-9001", commentBody: "x" }), { DEVLOOP_EVAL_KEYS: "" });
  check("set-but-empty: listed-looking key denied", r.status === 2, `got ${r.status}`);
}

// Spaces around commas are tolerated.
{
  const r = run(mcp("addCommentToJiraIssue", { issueIdOrKey: "TARS-9002", commentBody: "x" }), { DEVLOOP_EVAL_KEYS: "TARS-9001, TARS-9002" });
  check("set: spaced key list parsed", r.status === 0, `got ${r.status}, stderr: ${r.stderr}`);
}

// Checker failures fail closed.
{
  const stdin = mcp("addCommentToJiraIssue", { issueIdOrKey: "TARS-9001", commentBody: "x" });
  withTempLayout(HOOK, { "check-eval-jira-write-in-tool-input.ts": BROKEN_CHECKER }, (path, root) => {
    const r = run(stdin, { ...ON, CLAUDE_PROJECT_DIR: root }, { path });
    check("checker-failure: exit code is 2 (fail closed)", r.status === 2, `got ${r.status}`);
    check("checker-failure: reason says the check could not run", r.stderr.includes("could not verify"), r.stderr);
  });
  withTempLayout(HOOK, {}, (path, root) => {
    const r = run(stdin, { ...ON, CLAUDE_PROJECT_DIR: root }, { path });
    check("checker missing: exit code is 2 (fail closed)", r.status === 2, `got ${r.status}`);
  });
}

// Run from a cwd outside the repo (a skill that cd'd into its worktree).
withOutsideCwd((cwd) => {
  const deny = run(mcp("addCommentToJiraIssue", { issueIdOrKey: "TARS-1", commentBody: "x" }), ON, { cwd });
  check("cwd outside the repo: foreign key denied", deny.status === 2, `got ${deny.status}`);
  const allow = run(mcp("addCommentToJiraIssue", { issueIdOrKey: "TARS-9001", commentBody: "x" }), ON, { cwd });
  check("cwd outside the repo: listed key allowed (checker resolved)", allow.status === 0, `got ${allow.status}, stderr: ${allow.stderr}`);
});

// Registered in .claude/settings.json PreToolUse on every mcp__atlassian__ tool.
{
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf8"));
  const groups = settings.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command.endsWith(`/.claude/hooks/${HOOK}`)));
  check("settings.json registers the hook", groups.length === 1, JSON.stringify(groups));
  const matcher = groups[0]?.matcher ?? "";
  check("settings.json matcher covers every MCP tool, any server", ["mcp__atlassian__transitionJiraIssue", "mcp__atlassian__someFutureWrite", "mcp__mcp-gateway__transitionJiraIssue"].every((t) => new RegExp(`^(?:${matcher})$`).test(t)), matcher);
}

finish();
