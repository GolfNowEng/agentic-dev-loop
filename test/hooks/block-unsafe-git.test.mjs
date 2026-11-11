// End-to-end test of .claude/hooks/block-unsafe-git.sh (A4: no force push,
// no hook bypass, no `gh stack push/sync/submit`), driven via real piped
// stdin JSON the same shape Claude Code sends a PreToolUse hook for a Bash
// tool call. Run with:
//   npm run test:hooks
//   node test/hooks/block-unsafe-git.test.mjs

import { BROKEN_CHECKER, runHook, withTempLayout, withNoJqPath, withOutsideCwd, check, finish } from "./_helpers.mjs";

const HOOK = "block-unsafe-git.sh";
const bash = (command) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

const DENY = [
  // force pushes
  "git push --force",
  "git push --force origin main",
  "git push -f",
  "git push origin main -f",
  "git push -uf origin x",
  "git push --force-with-lease",
  "git push --force-with-lease=main:abc123 origin main",
  "git push --force-if-includes --force-with-lease origin x",
  "git push --force-if-includes",
  "git push origin +main",
  "git push origin +HEAD:refs/heads/x",
  "git push --mirror",
  "git push --forc origin x", // git accepts unambiguous long-option prefixes
  // hook bypass
  "git push --no-verify",
  "git push --no-verify -u origin x",
  "git push -n origin x",
  "git commit -n",
  "git commit -n -m 'msg'",
  "git commit -nm 'msg'",
  "git commit -an -m msg",
  "git commit --no-verify -m msg",
  "git commit --no-veri -m msg",
  "git commit -m 'msg' --no-verify",
  "git -c core.hooksPath=/dev/null commit -m msg",
  "git config core.hooksPath /dev/null",
  "HUSKY=0 git commit -m msg",
  "HUSKY=0 git push -u origin x",
  // gh stack
  "gh stack push",
  "gh stack sync",
  "gh stack submit",
  "gh stack submit --draft",
  // global options before the subcommand
  "git -C /tmp/repo push --force",
  "git -C /tmp/repo commit -n -m x",
  "/usr/bin/git push -f",
  // chains
  "npm test && git push --force",
  "git status; git push -f origin x",
  "false || git push -f",
  "git log | git push -f",
  "cd /tmp/x && git add . && git commit -n -m wip && git push -u origin x",
  "npm test && gh stack submit",
  "(cd repo && git push -f)",
  "{ git push -f; }",
  "git add .\ngit commit --no-verify -m x",
  // wrappers / nested shells
  'bash -c "git push --force"',
  "sh -c 'git push -f origin x'",
  "bash -lc 'git commit -n -m x'",
  'bash -c "cd x && gh stack push"',
  "eval 'git push -f'",
  "FOO=1 git push -f",
  "FOO=1 BAR=2 git push --force-with-lease",
  "env FOO=1 git push -f",
  "command git push -f",
  "nohup git push -f &",
  "timeout 60 git push -f",
  "echo $(git push -f)",
  "echo `git push -f`",
  'echo "$(git push --force)"',
  // obfuscation by quoting
  "g'i't push -f",
  'git "push" "--force"',
  "git push \\-f",
];

const ALLOW = [
  "git push -u origin X",
  "git push -u origin feat/TARS-1-thing",
  "git push origin HEAD",
  "git push --set-upstream origin x",
  "git push --follow-tags origin x",
  "gh stack link 12 13",
  "gh stack view",
  "gh stack init",
  "git grep -n foo",
  "git log -n 5",
  "git grep -n x && git push -u origin y",
  "git commit -m 'fix: thing'",
  "git commit -am 'fix: thing'",
  "git commit -m -n", // -n is -m's value, not a flag
  'git commit -m "docs: never git push --force or use --no-verify"',
  "git commit -m \"$(cat <<'EOF'\nfix: never git push --force\n\n- git commit -n is banned (RED)\nEOF\n)\"",
  "git status",
  "git diff --name-only",
  "git fetch origin --force", // fetch --force is not a push
  "git worktree remove --force /tmp/wt",
  "git branch -f x origin/x",
  "git checkout -f",
  "npm test",
  "ls -la",
  "grep -n 'git push -f' docs/notes.md",
  "gh pr create --title 'x' --body 'never gh stack submit here'",
  "echo 'git push -f'",
  "",
];

for (const command of DENY) {
  const result = runHook(HOOK, bash(command));
  check(`deny: ${JSON.stringify(command)}`, result.status === 2, `got ${result.status}, stderr: ${result.stderr}`);
}
for (const command of ALLOW) {
  const result = runHook(HOOK, bash(command));
  check(`allow: ${JSON.stringify(command)}`, result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

// The denial says what was blocked and why, without echoing the whole command.
{
  const result = runHook(HOOK, bash("git push --force origin main"));
  check("denial stderr is non-empty and names the rule", /BLOCKED/.test(result.stderr) && /force/i.test(result.stderr), result.stderr);
}

// Non-Bash tool calls are not this hook's business.
{
  const result = runHook(HOOK, JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }));
  check("non-Bash tool: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

// Fail closed on anything the hook cannot verify.
{
  const result = runHook(HOOK, "{not valid json");
  check("malformed stdin JSON: exit code is 2", result.status === 2, `got ${result.status}`);
}
{
  const result = runHook(HOOK, bash("git push 'unterminated"));
  check("unparseable command (unterminated quote): exit code is 2", result.status === 2, `got ${result.status}`);
  check("unparseable command: stderr says could not verify", result.stderr.includes("could not verify"), result.stderr);
}
withNoJqPath((dir) => {
  const result = runHook(HOOK, bash("git push -u origin x"), { env: { PATH: dir } });
  check("jq missing from PATH: exit code is 2", result.status === 2, `got ${result.status}`);
  check("jq missing from PATH: stderr names jq", /jq/i.test(result.stderr) && /not found/i.test(result.stderr), result.stderr);
});
withTempLayout(HOOK, { "check-unsafe-git-in-tool-input.ts": BROKEN_CHECKER }, (path, root) => {
  const result = runHook(HOOK, bash("git push -u origin x"), { path, env: { CLAUDE_PROJECT_DIR: root } });
  check("checker crash: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}`);
  check("checker crash: stderr says could not verify", result.stderr.includes("could not verify"), result.stderr);
});
withTempLayout(HOOK, {}, (path, root) => {
  const result = runHook(HOOK, bash("git push -u origin x"), { path, env: { CLAUDE_PROJECT_DIR: root } });
  check("checker missing: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}`);
});

// Run from a cwd outside the repo (a skill that cd'd into its worktree).
withOutsideCwd((cwd) => {
  const deny = runHook(HOOK, bash("git push --force"), { cwd });
  check("cwd outside the repo: force push denied", deny.status === 2, `got ${deny.status}, stderr: ${deny.stderr}`);
  const allow = runHook(HOOK, bash("git push -u origin x"), { cwd });
  check("cwd outside the repo: plain push allowed (checker resolved)", allow.status === 0, `got ${allow.status}, stderr: ${allow.stderr}`);
});

// A push argument only known at run time is denied, and the denial says how
// to spell it instead (Ruling 24a).
{
  const result = runHook(HOOK, bash('git push -u origin "$BRANCH"'));
  check("run-time push value: exit code is 2", result.status === 2, `got ${result.status}`);
  check(
    "run-time push value: stderr says spell the branch name literally, or use HEAD",
    result.stderr.includes("spell the branch name literally, or use HEAD"),
    result.stderr,
  );
}

finish();
