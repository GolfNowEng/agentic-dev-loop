# Host-side commit signing for sandboxed dev runs

Status: DRAFT, awaiting approval. Date: 2026-11-17.

## Problem

webtarsthree requires signed commits (GitHub rule GH013, "Commits must have
verified signatures"). On the host, git signs every commit with the
operator's SSH key (`commit.gpgsign=true`, `gpg.format=ssh`). The sbx
sandbox has no key, and it commits as `agent@<sandbox>.docker.internal`.
So every sandboxed dev run that gets to Phase 5 is refused at push.
TARS-1634 run 2 (2026-11-17): 7845 tests and QA passed, then the push was
refused, and commit `c655a741` was left unsigned on
`feat/TARS-1634-okta-docs-stale`.

## Decisions already made (by the operator)

- **No signing key in the sandbox.** If the sandbox held a key, the agent
  would decide what gets signed, which defeats the point of sbx.
- **push-branch stays unchanged.** It gets no caller-specific flags and no
  copy of its logic in dev-loop.
- **sbx details stay in `src/sandbox/sbx/`.** A run without `--sandbox`
  behaves exactly as it does today.

## Design

### 1. The adapter says "pushes happen on the host"

Add an optional `SandboxAdapter` hook: `hostPush?(config): boolean`. sbx
returns `true`. `none` and other adapters leave it out, so the default is
false.

When it is true, `skill-runner.ts` adds `push=host` to the dev prompt, the
same way it adds `push-branch=<path>` today. There is no `--sandbox`, the
hook is absent, and the prompt is byte-identical to today's. A test pins
that.

### 2. ticket-to-pr Phase 5 with `push=host`

Phases 0–4 don't change. In Phase 5, with `push=host`, dev does **not** read
push-branch and does **not** push. It writes `verdict.json` with:

- `outcome: "ready_to_push"`
- `phase_reached: "pr"`
- `branch`: the literal branch name, after any version-guard rename it
  did itself
- `pr_title` and `pr_body`: the Phase 4 step 7 text, verbatim
- the usual metrics and `qa_notes`

Phase 5 can't do push-branch's version-guard rename here, because the
rename happens inside push-branch. That's fine: push-branch still runs on
the host (step 4), and it does the rename and adds the label there.

`ready_to_push` is a new executor outcome. Only `runDevPhase` acts on it,
and only when the adapter has `hostPush` set. Anywhere else (a host run
that somehow returns it), it is treated as `error` / `agent_error`, so
nothing pushes by surprise.

### 3. Host re-sign (`src/roles/dev/host-sign.ts`, plain code, no LLM)

It works in the run's worktree on the host. That's the same directory the
sandbox mounted, so the commits are already there. In order:

1. **Preconditions** (any failure means a bounce, step 6):
   - The worktree is clean.
   - HEAD is `branch`.
   - `branch` matches the ticket key.
2. **Base:** `origin/<branch>` if the branch exists on origin (found with
   `git ls-remote`), otherwise `origin/<defaultBranch>`.
3. **Range to sign:** `git rev-list <base>..<branch>`.
   - It must not be empty.
   - It must hold no merge commits.
   - None of its commits may already be reachable from any `origin/*` ref.
   - If any of these fail, it refuses. It never rewrites pushed history.
4. **Re-sign:**
   - Run `git rebase --exec "git commit --amend --no-edit --reset-author -S" <base>`.
   - `--reset-author` makes the author and committer the operator. They
     have to be, because GitHub only marks a signature "verified" when the
     committer email belongs to the key's account.
   - Commit hooks run as normal. They are never bypassed (no `--no-verify`).
5. **Proof** (if any check fails, run `git reset --hard <old tip>` back to
   the recorded old tip, then bounce):
   - The tree of the new tip equals the tree of the old tip. Signing must
     never change content.
   - Every commit in the range shows `%G? = G`.
   - The old tip SHA is recorded in `progress.jsonl` for recovery.

### 4. Host push: push-branch unchanged

The loop spawns a small `claude -p` on the host, without a sandbox:

- **Working directory:** the worktree.
- **Tools:** the dev allowlist and the same hooks as dev today. So the
  unsafe-git and secret-comment hooks still apply.
- **Prompt:** read `~/.claude/skills/push-branch/SKILL.md` and follow it in
  content-supplied mode with `--title`, `Body:` and `--no-jira`, using
  `pr_title` and `pr_body` verbatim. Then write `{pr: <url>}` to a small
  result file.
- **Model:** the sonnet tier.

This is exactly the call ticket-to-pr Phase 5 makes on a host run. Only the
caller is different.

### 5. Then the normal landed path

When the push succeeds, `runDevPhase` turns the verdict into
`outcome: "landed"` with `pr` set. From there it carries on exactly like a
host run: the Jira move to Code Review with the QA Notes field, then the
GitHub detail comment. The run record gets a `host_push` note showing the
commits signed, the old tip and the new tip.

### 6. Failures

Each failure bounces `env_setup` with a plain message, leaves the work
committed locally, and never pushes anything half-done:

| Failure | Message names | State left |
|---|---|---|
| Worktree dirty or wrong branch | the path and branch | untouched |
| Range already on origin, or has a merge | the commit | untouched |
| Signing fails (key or agent not available) | `git` stderr | old tip restored |
| Tree changed or a signature isn't `G` | the commit | old tip restored |
| Commit hook fails during the amend | the hook output | rebase aborted, old tip restored |
| push-branch push or PR fails | its error | signed commits kept, not pushed |

A retry after the last row works without any extra step. Step 3 re-signs
commits that are already signed, which is harmless, and push-branch
updates an existing PR in place.

## Out of scope

- Research runs. They never commit.
- Follow-up PRs (`-fu`). They follow later, using the same module.
- A reset case for "retry dev, keep its work". That is a separate item.

## Tests (TDD)

- **`host-sign`**, against temp git repos with a throwaway SSH signing key:
  - Signs only the unpushed range.
  - Refuses a range that has a pushed commit, and one that has a merge.
  - The tree is unchanged.
  - Restores the old tip when signing fails.
  - The author is reset.
- **`runDevPhase`:**
  - `ready_to_push` with `hostPush` set: sign, push, then landed with
    the Jira move.
  - `ready_to_push` without `hostPush`: agent_error.
  - Each failure row gives a bounce with the right message.
- **Prompt:** `push=host` appears only with an adapter that has `hostPush`.
  A host run's prompt doesn't change.
- **Verdict parser:** accepts `ready_to_push` with `branch`, `pr_title`
  and `pr_body` all present, and rejects it otherwise.
- **Structure test:** the word "sbx" still appears only in its folder.

## Open questions for the operator

1. **Hooks on amend.** webtarsthree's `.husky/pre-commit` runs `npm test`,
   the full suite of about 7845 tests. Re-signing N commits would run it N
   times, and dev usually makes 2–4 commits (RED, GREEN, fixes). The suite
   already passed in the sandbox on the same tree, and pre-push runs it
   once more before the push anyway. Options:
   - (a) **Proposed:** accept N runs. It's slow, a few minutes per commit,
     but it's honest. It doesn't skip any hook.
   - (b) Re-sign with `git -c core.hooksPath=/dev/null`. This is a hook
     bypass, which the standing rules forbid. Not proposed. It's listed
     only so it's clear it was ruled out.
2. **Model for the host push spawn:** sonnet tier (proposed) or haiku. It's
   mechanical, but push-branch's version guard involves some judgment.
