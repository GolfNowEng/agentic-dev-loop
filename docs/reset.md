# Resetting a ticket or project to a clean local state

`npm run reset-project` (backed by `src/reset-project.ts`, wired up via
`.claude/skills/reset-project/SKILL.md`) deterministically deletes this
repo's own local, gitignored pipeline state for one ticket or an entire
project, so it can be run through the pipeline again from scratch.

## Why this exists

Diagnosing a real pipeline bug usually means running a real ticket through
the pipeline live — TARS-1465 was used this way (from dev-loop's side) to
find and fix two real bugs downstream of research-loop's own hand-off.
Once a diagnostic session ends, a ticket's local history in *this* repo
(a `runs.jsonl` line, a run directory under `.pipeline/<slug>/runs/`, a
raw-usage file, sometimes a leftover Ground-step worktree) is no longer
representative of a real run and would confuse a genuine fresh test —
`ticket-refine`'s own idempotent-re-refinement check (see `docs/skills.md`)
reads for a prior research-loop comment to decide "first pickup" vs.
"re-pickup," so stale *local* history mixed with a ticket a human reset in
Jira can produce a confusing mismatch between what this repo remembers and
what Jira/GitHub actually show.

Before this script existed, cleaning that up meant hand-rolling
`grep -v`/`rm -rf` against `runs.jsonl` and `.pipeline/<slug>/` each time —
error-prone (easy to `grep -v` the wrong ticket key, or `rm -rf` a sibling
ticket's directory by an over-broad glob) and not repeatable. This script
replaces that with tested, deterministic logic — ported directly from
dev-loop's identical `src/reset-project.ts`/`src/reset-cli.ts` (same
scoping rules, same test suite, same CLI shape), since both repos share
the exact same local-state layout (`runs/<project>.jsonl`,
`.pipeline/<project>/`, `.gitignore`'s `runs/`/`.pipeline/` entries).

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
- `<targetRepo.path>/.claude/worktrees/<TICKET>-<RUN_ID>-ground/` — this
  repo's own leftover Ground-step worktrees in the *target* repo checkout,
  when `pipeline.<project>.config.json`'s `targetRepo.path` is set. Only
  swept for a per-ticket reset (see below for why not whole-project).

## What it deliberately never touches

- **Jira** — the ticket itself (status, labels, comments) is untouched.
  This includes the `pipeline:research`/`pipeline:dev` label swap — a
  reset never reverses that hand-off; a human decides what happens to the
  real ticket. This script only ever clears *this repo's own local
  record* of having worked it.
- **GitHub** — no Issue comment, no Issue close. Same reasoning: those
  are shared, visible-to-others state, categorically different from a
  local scratch file only this machine's research-loop process ever
  reads.
- **Another ticket's or another project's data** — every deletion is
  keyed by an exact `<TICKET>-` prefix match (never a broader glob), and
  a whole-project reset only ever touches `runs/<THIS-project>.jsonl` and
  `.pipeline/<THIS-project>/`, never a sibling project's directory.
  Covered directly by `test/reset-project.test.ts`.

If you also need to close out the real Jira ticket / GitHub Issue from a
prior test run, or reset its label back to `pipeline:research` for a
genuine first-pickup-shaped re-run, do that separately (by hand, or by
asking an agent) — see `SKILL.md`'s own note on this. Keeping the two
concerns apart means running this script is always safe to run
speculatively without ever risking a write to a shared system.

## Why worktrees aren't swept in whole-project mode

A per-ticket reset can safely list
`<targetRepo.path>/.claude/worktrees/<TICKET>-*` and delete exactly those —
the ticket key is the scoping key, and Ground-step worktree directory
names always start with it. A whole-project reset has no equally precise
scoping key to sweep *all* worktrees for a project by: `targetRepo.path`
is a directory on disk, not namespaced per project the way
`.pipeline/<slug>/` is, and two different `pipeline.<project>.config.json`
files could (in principle) point `targetRepo.path` at the very same
checkout. Deleting "every worktree under this path" on a whole-project
reset risks deleting another project's in-progress worktree. Left
unswept deliberately; a whole-project reset's own printed plan says so,
and a human can inspect `<targetRepo.path>/.claude/worktrees/` by hand if
leftover worktrees from the wiped project need cleanup too.

## Dry-run first

`--dry-run` prints the exact same plan `planReset()` computes for the real
run — never a separate, potentially-diverging "preview" logic path (see
`src/reset-project.ts`'s own top-of-file comment). Always safe to run
before the real thing.
