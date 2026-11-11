// End-to-end test of .claude/hooks/block-secret-comments.sh, driven via
// real piped stdin JSON the same shape Claude Code sends a PreToolUse
// hook. The hook is the merge of dev-loop's (Bash `gh pr create/edit`)
// and research-loop's (`mcp__atlassian__*` writes) versions, so this file
// carries every case from both repos' tests. Run with:
//   npm run test:hooks        (all hook tests)
//   node test/hooks/block-secret-comments.test.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  BROKEN_CHECKER,
  runHook,
  withTempLayout,
  withNoJqPath,
  check,
  finish,
} from "./_helpers.mjs";

const HOOK = "block-secret-comments.sh";
const SECRET = "CLIENT_SECRET=abcdefghijklmnop";
const run = (stdin, opts) => runHook(HOOK, stdin, opts);
const bash = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });
const mcp = (tool_name, tool_input) => JSON.stringify({ tool_name, tool_input });

// ---------------------------------------------------------------------------
// Bash shape (from dev-loop's test)
// ---------------------------------------------------------------------------

{
  const result = run(bash(`gh pr create --title "TARS-1" --body "${SECRET} found hardcoded"`));
  check("secret-shaped gh pr create: exit code is 2", result.status === 2, `got ${result.status}`);
  check("secret-shaped gh pr create: stderr is non-empty", result.stderr.trim().length > 0);
  check(
    "secret-shaped gh pr create: stderr does not contain the actual secret value",
    !result.stderr.includes("abcdefghijklmnop"),
    result.stderr,
  );
}

{
  const result = run(bash("gh pr edit 123 --body 'SIGNING_KEY=abcdefghijklmnop'"));
  check("secret-shaped gh pr edit: exit code is 2", result.status === 2, `got ${result.status}`);
}

{
  const result = run(bash('gh pr create --title "TARS-1" --body "## Changes\n- clean change"'));
  check("clean gh pr create: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

{
  const result = run(bash("npm test"));
  check("unrelated Bash command: exit code is 0", result.status === 0, `got ${result.status}`);
}

{
  const result = run(bash(`gh pr view 42 # ${SECRET}`));
  check("gh pr view: exit code is 0", result.status === 0, `got ${result.status}`);
}

// gh pr create split across lines (the reason the pre-filter is three
// independent word checks, not one `.*` regex).
{
  const result = run(bash(`gh pr \\\n  create --body "${SECRET}"`));
  check("multi-line gh pr create with a secret: exit code is 2", result.status === 2, `got ${result.status}`);
}

// CLAUDE_PROJECT_DIR unset/empty must never be a fail-OPEN exit 1 under
// `set -u`. The checker is now located relative to the hook script itself,
// so an empty CLAUDE_PROJECT_DIR changes nothing: a secret still denies and
// a clean write is still allowed.
{
  const result = run(bash(`gh pr create --title "TARS-1" --body "${SECRET}"`), { env: { CLAUDE_PROJECT_DIR: "" } });
  check(
    "CLAUDE_PROJECT_DIR empty, secret: exit code is 2 (fail closed), not 1 (fail open)",
    result.status === 2,
    `got ${result.status}, stderr: ${result.stderr}`,
  );
  check("CLAUDE_PROJECT_DIR empty, secret: stderr is non-empty", result.stderr.trim().length > 0, result.stderr);
  const clean = run(bash('gh pr create --title "TARS-1" --body "clean"'), { env: { CLAUDE_PROJECT_DIR: "" } });
  check(
    "CLAUDE_PROJECT_DIR empty, clean: exit code is 0 (checker found without it)",
    clean.status === 0,
    `got ${clean.status}, stderr: ${clean.stderr}`,
  );
}
{
  const result = runHook(HOOK, bash(`gh pr create --body "${SECRET}"`), { env: { CLAUDE_PROJECT_DIR: undefined } });
  check("CLAUDE_PROJECT_DIR unset, secret: exit code is 2", result.status === 2, `got ${result.status}`);
}

// jq missing from PATH fails closed with a message distinct from malformed JSON.
withNoJqPath((dir) => {
  const result = run(bash('gh pr create --title "TARS-1" --body "irrelevant"'), { env: { PATH: dir } });
  check("jq missing from PATH: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}, stderr: ${result.stderr}`);
  check(
    "jq missing from PATH: stderr mentions jq/not found, not malformed JSON",
    /jq/i.test(result.stderr) && /not found/i.test(result.stderr) && !/malformed JSON/i.test(result.stderr),
    result.stderr,
  );
});

{
  const result = run("{not valid json");
  check("malformed stdin JSON: exit code is 2", result.status === 2, `got ${result.status}`);
  check("malformed stdin JSON: stderr says malformed JSON", /malformed JSON/i.test(result.stderr), result.stderr);
}

// ---------------------------------------------------------------------------
// mcp__atlassian__* shape (from research-loop's test)
// ---------------------------------------------------------------------------

{
  const result = run(mcp("mcp__atlassian__addCommentToJiraIssue", { commentBody: `${SECRET} was found hardcoded` }));
  check("secret-shaped MCP input: exit code is 2", result.status === 2, `got ${result.status}`);
  check("secret-shaped MCP input: stderr is non-empty", result.stderr.trim().length > 0);
  check(
    "secret-shaped MCP input: stderr does not contain the actual secret value",
    !result.stderr.includes("abcdefghijklmnop"),
    result.stderr,
  );
}

{
  const result = run(mcp("mcp__atlassian__addCommentToJiraIssue", { commentBody: "Ground confirmed the fix works as expected." }));
  check("clean MCP input: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

{
  const result = run(
    mcp("mcp__atlassian__editJiraIssue", {
      issueIdOrKey: "TARS-1",
      fields: { description: `Found ${SECRET} hardcoded in config.py` },
    }),
  );
  check("secret nested in MCP tool_input.fields: exit code is 2", result.status === 2, `got ${result.status}`);
}

// Table-driven: every tool name in the merged mcp__atlassian__(...) matcher
// denies a seeded fake secret. Names come from .claude/settings.json itself,
// so a tool added to the matcher is covered without editing this file.
{
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf8"));
  const matcher = (settings.hooks?.PreToolUse ?? []).map((e) => e.matcher).find((m) => m?.startsWith("mcp__atlassian__"));
  const names = /^mcp__atlassian__\((.+)\)$/.exec(matcher ?? "")?.[1]?.split("|") ?? [];
  check("settings.json has an mcp__atlassian__(...) matcher with tool names", names.length > 0, String(matcher));
  for (const name of names) {
    const tool = `mcp__atlassian__${name}`;
    const result = run(mcp(tool, { cloudId: "x", body: `note: ${SECRET}`, commentBody: `note: ${SECRET}` }));
    check(`table: ${tool} with a seeded secret: exit code is 2`, result.status === 2, `got ${result.status}`);
    const clean = run(mcp(tool, { cloudId: "x", body: "clean", commentBody: "clean" }));
    check(`table: ${tool} clean: exit code is 0`, clean.status === 0, `got ${clean.status}, stderr: ${clean.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Checker failure modes (both shapes) -- each must fail closed with the
// distinct "could not verify" reason. Run against a throwaway copy of the
// hook so the real scripts/ directory is never renamed or overwritten.
// ---------------------------------------------------------------------------

for (const [label, stdin] of [
  ["Bash", bash("gh pr create --body irrelevant")],
  ["MCP", mcp("mcp__atlassian__addCommentToJiraIssue", { commentBody: "irrelevant" })],
]) {
  withTempLayout(HOOK, { "check-secret-in-tool-input.ts": BROKEN_CHECKER }, (path, root) => {
    const result = runHook(HOOK, stdin, { path, env: { CLAUDE_PROJECT_DIR: root } });
    check(`${label} checker crash: exit code is 2 (fail closed)`, result.status === 2, `got ${result.status}`);
    check(`${label} checker crash: stderr says could not verify`, result.stderr.includes("could not verify"), result.stderr);
  });

  withTempLayout(HOOK, {}, (path, root) => {
    const result = runHook(HOOK, stdin, { path, env: { CLAUDE_PROJECT_DIR: root } });
    check(`${label} checker file missing: exit code is 2 (fail closed)`, result.status === 2, `got ${result.status}`);
    check(`${label} checker file missing: stderr says could not verify`, result.stderr.includes("could not verify"), result.stderr);
  });

  // The real checker copied without the module it imports (src/core/redact.ts).
  const realChecker = readFileSync(join(REPO_ROOT, "scripts", "check-secret-in-tool-input.ts"), "utf8");
  withTempLayout(HOOK, { "check-secret-in-tool-input.ts": realChecker }, (path, root) => {
    const result = runHook(HOOK, stdin, { path, env: { CLAUDE_PROJECT_DIR: root } });
    check(`${label} checker's imported module missing: exit code is 2 (fail closed)`, result.status === 2, `got ${result.status}`);
  });
}

// ---------------------------------------------------------------------------
// Reached through research-loop/.claude (symlink to ../.claude) with
// CLAUDE_PROJECT_DIR=research-loop/, as a v1 `--phase research` spawn does.
// ---------------------------------------------------------------------------

{
  const viaResearch = { viaResearch: true };
  const a = run(mcp("mcp__atlassian__addCommentToJiraIssue", { commentBody: SECRET }), viaResearch);
  check("via research-loop/.claude: MCP secret: exit code is 2", a.status === 2, `got ${a.status}, stderr: ${a.stderr}`);
  const b = run(bash(`gh pr create --body "${SECRET}"`), viaResearch);
  check("via research-loop/.claude: gh pr secret: exit code is 2", b.status === 2, `got ${b.status}, stderr: ${b.stderr}`);
  const c = run(mcp("mcp__atlassian__addCommentToJiraIssue", { commentBody: "clean" }), viaResearch);
  check("via research-loop/.claude: clean MCP: exit code is 0 (checker resolved)", c.status === 0, `got ${c.status}, stderr: ${c.stderr}`);
}

finish();
