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

// createJiraIssue: allowed only with the [dev-loop-eval] summary prefix.
{
  const ok = run(mcp("createJiraIssue", { projectKey: "TARS", issueTypeName: "Task", summary: "[dev-loop-eval] follow-up" }));
  check("set: createJiraIssue with the prefix allowed", ok.status === 0, `got ${ok.status}, stderr: ${ok.stderr}`);
  const no = run(mcp("createJiraIssue", { projectKey: "TARS", issueTypeName: "Task", summary: "follow-up [dev-loop-eval]" }));
  check("set: createJiraIssue with the prefix not at the start denied", no.status === 2, `got ${no.status}`);
  const missing = run(mcp("createJiraIssue", { projectKey: "TARS", issueTypeName: "Task" }));
  check("set: createJiraIssue with no summary denied", missing.status === 2, `got ${missing.status}`);
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
  check("settings.json matcher covers every mcp__atlassian__ tool", new RegExp(`^(?:${matcher})$`).test("mcp__atlassian__transitionJiraIssue") && new RegExp(`^(?:${matcher})$`).test("mcp__atlassian__someFutureWrite"), matcher);
}

finish();
