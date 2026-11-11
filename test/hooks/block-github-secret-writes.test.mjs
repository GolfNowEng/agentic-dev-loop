// End-to-end test of .claude/hooks/block-github-secret-writes.sh (Bash
// `gh issue create/edit/comment` writes), driven via real piped stdin JSON
// the same shape Claude Code sends a PreToolUse hook for a Bash call.
// Moved from research-loop/test/hooks/ (every original case kept). Run with:
//   npm run test:hooks
//   node test/hooks/block-github-secret-writes.test.mjs

import { BROKEN_CHECKER, runHook, withTempLayout, withNoJqPath, check, finish } from "./_helpers.mjs";

const HOOK = "block-github-secret-writes.sh";
const SECRET = "CLIENT_SECRET=abcdefghijklmnop";
const run = (stdin, opts) => runHook(HOOK, stdin, opts);
const bash = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

{
  const result = run(bash(`gh issue create --repo org/repo --title "PROJ-1: x" --body "${SECRET} found hardcoded"`));
  check("secret-shaped gh issue create: exit code is 2", result.status === 2, `got ${result.status}`);
  check("secret-shaped gh issue create: stderr is non-empty", result.stderr.trim().length > 0);
  check(
    "secret-shaped gh issue create: stderr does not contain the actual secret value",
    !result.stderr.includes("abcdefghijklmnop"),
    result.stderr,
  );
}

{
  const result = run(bash("gh issue comment 42 --body 'SIGNING_KEY=abcdefghijklmnop'"));
  check("secret-shaped gh issue comment: exit code is 2", result.status === 2, `got ${result.status}`);
}

{
  const result = run(bash("gh issue edit 42 --title 'PROJ-1: AWS key AKIAIOSFODNN7EXAMPLE found'"));
  check("secret-shaped gh issue edit: exit code is 2", result.status === 2, `got ${result.status}`);
}

{
  const result = run(bash('gh issue create --repo org/repo --title "PROJ-1: x" --body "clean"'));
  check("clean gh issue create: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

{
  const result = run(bash("npm test"));
  check("unrelated Bash command: exit code is 0", result.status === 0, `got ${result.status}`);
}

{
  const result = run(bash(`gh issue view 42 # ${SECRET}`));
  check("gh issue view: exit code is 0", result.status === 0, `got ${result.status}`);
}

// gh pr writes are block-secret-comments.sh's surface, not this hook's.
{
  const result = run(bash(`gh pr create --title "x" --body "${SECRET}"`));
  check("gh pr create (not gh issue): exit code is 0 -- out of this hook's scope", result.status === 0, `got ${result.status}`);
}

for (const [label, checkers] of [
  ["checker crash", { "check-secret-in-tool-input.ts": BROKEN_CHECKER }],
  ["checker missing", {}],
]) {
  withTempLayout(HOOK, checkers, (path, root) => {
    const result = run(bash("gh issue create --body irrelevant"), { path, env: { CLAUDE_PROJECT_DIR: root } });
    check(`${label}: exit code is 2 (fail closed)`, result.status === 2, `got ${result.status}`);
    check(`${label}: stderr says could not verify`, result.stderr.includes("could not verify"), result.stderr);
  });
}

withNoJqPath((dir) => {
  const result = run(bash('gh issue create --title "PROJ-1" --body "irrelevant"'), { env: { PATH: dir } });
  check("jq missing from PATH: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}, stderr: ${result.stderr}`);
  check(
    "jq missing from PATH: stderr mentions jq/not found, not malformed JSON",
    /jq/i.test(result.stderr) && /not found/i.test(result.stderr) && !/malformed JSON/i.test(result.stderr),
    result.stderr,
  );
});

{
  const result = run(bash(`gh issue create --body "${SECRET}"`), { env: { CLAUDE_PROJECT_DIR: undefined } });
  check("CLAUDE_PROJECT_DIR unset: secret still denied (exit 2)", result.status === 2, `got ${result.status}, stderr: ${result.stderr}`);
}

// Reached through research-loop/.claude with CLAUDE_PROJECT_DIR=research-loop/.
{
  const deny = run(bash(`gh issue comment 42 --body "${SECRET}"`), { viaResearch: true });
  check("via research-loop/.claude: gh issue secret denied", deny.status === 2, `got ${deny.status}, stderr: ${deny.stderr}`);
  const allow = run(bash("gh issue comment 42 --body clean"), { viaResearch: true });
  check("via research-loop/.claude: clean comment allowed (checker resolved)", allow.status === 0, `got ${allow.status}, stderr: ${allow.stderr}`);
}

finish();
