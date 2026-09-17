# Resetting a ticket or project to a clean local state

`npm run reset-project` (backed by `src/reset-project.ts`, wired up via
`.claude/skills/reset-project/SKILL.md`) deterministically deletes this
repo's own local, gitignored pipeline state for one ticket or an entire
project, so it can be run through the pipeline again from scratch.

## Why this exists

Diagnosing a real pipeline bug usually means running a real ticket through
the pipeline live — TARS-1465 was used this way to find and fix two real
bugs (`pollJql.dev` re-polling a landed ticket, and a stuck Code Review
transition on an issue type whose workflow didn't support it). Once the
bug is fixed, the ticket's local history (multiple `runs.jsonl` lines, a
run directory per attempt, raw-usage files, sometimes a leftover worktree)
is no longer representative of a real run and would confuse a genuine
fresh test — `ticket-to-pr`'s own Phase 0 intake reads prior "landed" runs
via `findLandedPrUrl` (see `src/reconcile.ts`), so stale history from a
diagnostic session can produce misleading "already landed" bounces on a
ticket you're trying to test fresh.

Before this script existed, cleaning that up meant hand-rolling
`grep -v`/`rm -rf` against `runs.jsonl` and `.pipeline/<slug>/` each time —
error-prone (easy to `grep -v` the wrong ticket key, or `rm -rf` a sibling
ticket's directory by an over-broad glob) and not repeatable. This script
replaces that with tested, deterministic logic.

## Scope: strictly local and gitignored

Every path this script touches is already covered by this repo's own
`.gitignore` (`runs/`, `.pipeline/`) — nothing it deletes is tracked
source, and nothing it deletes exists anywhere but this machine:

- `runs/<project>.jsonl` — the append-only run-history log
  (`docs/logging.md`).
- `.pipeline/<project>/runs/<TICKET>-<RUN_ID>/` — per-run scratch dirs
  (`progress.jsonl`, `verdict.json`).
- `.pipeline/<project>/raw-usage/<TICKET>-<...>.json` — measured token-usage
  records from `claude -p`'s own usage report.
- `<targetRepo.path>/.claude/worktrees/<TICKET>-<...>/` — this repo's own
  leftover worktrees in the *target* repo checkout, when
  `pipeline.<project>.config.json`'s `targetRepo.path` is set. Only swept
  for a per-ticket reset (see below for why not whole-project).

## What it deliberately never touches

- **Jira** — the ticket itself (status, labels, comments, issue type) is
  untouched. A human (or a separate skill/step) decides what happens to
  the real ticket; this script only ever clears *this repo's own local
  record* of having worked it.
- **GitHub** — no Issue comment, no Issue close, no PR close/merge, no
  branch delete (local or remote). Same reasoning: those are shared,
  visible-to-others state, categorically different from a local scratch
  file only this machine's dev-loop process ever reads.
- **Another ticket's or another project's data** — every deletion is keyed
  by an exact `<TICKET>-` prefix match (never a broader glob), and a
  whole-project reset only ever touches `runs/<THIS-project>.jsonl` and
  `.pipeline/<THIS-project>/`, never a sibling project's directory. Covered
  directly by `test/reset-project.test.ts`.

If you also need to close out the real Jira ticket / GitHub Issue / PR from
a prior test run, do that separately (by hand, or by asking an agent) — see
`SKILL.md`'s own note on this. Keeping the two concerns apart means running
this script is always safe to run speculatively (e.g. from a shell script,
or a future automated "prep for the next test run" step) without ever risking
a write to a shared system.

## Why worktrees aren't swept in whole-project mode

A per-ticket reset can safely list
`<targetRepo.path>/.claude/worktrees/<TICKET>-*` and delete exactly those —
the ticket key is the scoping key, and worktree directory names always
start with it (`ticket-to-pr`'s own convention, `docs/logging.md`). A
whole-project reset has no equally precise scoping key to sweep *all*
worktrees for a project by: `targetRepo.path` is a directory on disk, not
namespaced per project the way `.pipeline/<slug>/` is, and two different
`pipeline.<project>.config.json` files could (in principle) point
`targetRepo.path` at the very same checkout. Deleting "every worktree under
this path" on a whole-project reset risks deleting another project's
in-progress worktree. Left unswept deliberately; a whole-project reset's
own printed plan says so, and a human can inspect
`<targetRepo.path>/.claude/worktrees/` by hand if leftover worktrees from
the wiped project need cleanup too.

## Dry-run first

`--dry-run` prints the exact same plan `planReset()` computes for the real
run — never a separate, potentially-diverging "preview" logic path (see
`src/reset-project.ts`'s own top-of-file comment). Always safe to run
before the real thing.
