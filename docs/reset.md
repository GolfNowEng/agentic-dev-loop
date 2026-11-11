# Resetting a ticket or project to a clean local state

## 2.0.0: v2 state, `--role` (current behavior)

`npm run reset-project` (`src/core/reset-cli.ts` over
`src/core/reset-project.ts`, wired up via
`.claude/skills/reset-project/SKILL.md`) deterministically resets this
repo's own **v2** pipeline state for one project, optionally one ticket,
and optionally one role. Every path comes from `src/core/paths.ts`, under
the repo root (or `--root <dir>`), independent of the cwd.

```bash
npm run reset-project -- --project webtarsthree --ticket TARS-1465 --dry-run           # role all
npm run reset-project -- --project webtarsthree --ticket TARS-1465 --role research
npm run reset-project -- --project webtarsthree --ticket TARS-1465 --role research --include-cross-role
npm run reset-project -- --project webtarsthree --yes                                   # whole project
npm run reset-project:remote -- --project webtarsthree --ticket TARS-1465 --close-remote --dry-run
```

**`--role research|dev|all`** (default `all`):

| | `research` / `dev` | `all` |
|---|---|---|
| run dirs | `.pipeline/v2/<project>/<session>/<ticket>/<role>-<RUN_ID>/`, every session | both roles' |
| `runs/v2/<project>.jsonl` | records with a phase of that role, or `resume: <role>` | every record for the ticket (whole project: every line, unreadable ones included) |
| worktrees (`--ticket` only) | research: `<TICKET>-*-ground`; dev: the other `<TICKET>-*` | all `<TICKET>-*` |

**Cross-role safety.** A record can hold both roles' phases (research
landed, then dev in the same iteration). With `--role research` or
`--role dev`, a matching record that also has a `landed` phase of the
**other** role is **refused** by default: it stays in the live log, and
the plan prints `REFUSED (other role landed: <role> <pr|outcome>)` for it.
This matters because archiving `[research, dev landed PR X]` under
`--role research` would remove PR X from the dev landed guard, from
reconcile and from `--close-remote`'s PR lookup, so the dev poll could
open a second PR. `--include-cross-role` archives such records anyway.
`--role all` is unaffected.

**Live worker.** A real (non-dry-run) reset refuses while a live worker
holds a `*.lock` in `.pipeline/v2/<project>/sessions/` (holder pid and
start time checked with session.ts's `isProcessAlive`); `--ignore-live-worker`
overrides. `--dry-run` only prints the WARNING.

**Symlinks.** The run-dir scan uses `lstat` and never follows a symlink:
a symlinked session, ticket or run dir is skipped and printed as a
WARNING, so a delete can never reach outside `.pipeline/v2/<project>/`.

Archived records are appended to `runs/v2/<project>.reset-archive.jsonl`
before the live log is rewritten (temp file + rename), or deleted when a
whole-project reset empties it. Worktrees are found under
`targetRepo.path` when set, else the v2 clone `.pipeline/v2/<project>/repo`.

**Whole project, `--role all` only**: also prunes the session dir's
leftovers in `.pipeline/v2/<project>/sessions/`: `*.lock.adopted-*`,
`.acquire.stale-*`, `.acquire.reclaim-*`, `.acquire.release-*`, `.tmp-*`.
It never removes a `*.lock`, a `*.lock.stale-*` (it may hold an in-flight
record a worker has not adopted yet) or the `.acquire` mutex. A present
`*.lock` is reported as a warning: stop the worker before resetting.

**Never touched, in any mode:** all v1 history, in both layouts:
`runs/v1/**`, `.pipeline/v1/**`, and the pre-cutover `runs/<slug>.jsonl`,
`runs/<slug>.reset-archive.jsonl`, `.pipeline/<slug>/`,
`research-loop/runs/`, `research-loop/.pipeline/`. Also the clone
`.pipeline/v2/<project>/repo`, another project's state, Jira, GitHub, and
git history. `executeReset` refuses a plan naming any path outside the
project's v2 roots. Tests: `test/core/reset-project.test.ts` (both v1
layouts, every role and scope) and `test/core/reset-cli.test.ts`.

**`--close-remote`** (requires `--ticket`) is unchanged in what it closes
(Jira ticket, mirror Issue, PR). The PR is the ticket's latest recorded
landed/bounced dev PR from the v2 log, else the v1 dev log
(`findRecordedPrUrlAcross`), read before any record is archived. The
confirmation-first agent policy below still applies.

The two sections below are the pre-2.0.0 documents (v1 layout, the cwd
picking the role). Their rationale (why archive, why no whole-project
worktree sweep, how `--close-remote` walks Jira transitions) still holds;
their paths and "run it from `research-loop/`" instructions do not.

> Merged in dev-loop 2.0.0: one repo, two phases. "Research phase" is the
> former research-loop doc (`--phase research`); "Dev phase" is the former
> dev-loop doc (`--phase dev`). Wording inside each section still describes its
> repo as it was; "this repo" / "the sibling repo" there means that phase, and
> paths like `src/types.ts` map to `src/core/` and `src/roles/<phase>/` now.
> See `docs/migration-ledger.md`.

## Research phase (v1, pre-2.0.0)

`npm run reset-project` (backed by `src/reset-project.ts`, wired up via
`.claude/skills/reset-project/SKILL.md`) deterministically deletes this
repo's own local, gitignored pipeline state for one ticket or an entire
project, so it can be run through the pipeline again from scratch.

### Why this exists

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

A second live test using this same "reset when done" workflow (TARS-1467,
an autonomous auto-promote handoff test) surfaced the same manual-cleanup
problem one level up: closing out the real Jira ticket and its GitHub
Issue was still done by hand. `--close-remote` (see below) and
`runs.jsonl` archiving extend this script to cover that too,
deterministically -- ported from dev-loop's identical extension, minus
its PR-closing capability (this repo never opens a PR).

### Scope: strictly local and gitignored

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

### What local reset deliberately never touches

- **Jira** — the ticket itself (status, labels, comments) is untouched.
  This includes the `pipeline:research`/`pipeline:dev` label swap — local
  reset never reverses that hand-off; a human (or `--close-remote` — see
  below) decides what happens to the real ticket.
- **GitHub** — no Issue comment, no Issue close. Same reasoning: those
  are shared, visible-to-others state, categorically different from a
  local scratch file only this machine's research-loop process ever
  reads.
- **Another ticket's or another project's data** — every deletion is
  keyed by an exact `<TICKET>-` prefix match (never a broader glob), and
  a whole-project reset only ever touches `runs/<THIS-project>.jsonl` and
  `.pipeline/<THIS-project>/`, never a sibling project's directory.
  Covered directly by `test/reset-project.test.ts`.

Local reset and remote-closing are deliberately separate code paths
(`src/reset-project.ts` vs. `src/remote-close.ts`) and separate flags
(default vs. `--close-remote`) — keeping them apart means a local-only
reset is always safe to run speculatively without ever risking a write
to a shared system, regardless of whether `--close-remote` exists at all.

### `--close-remote`: closing the real Jira ticket and Issue

Opt-in, and requires `--ticket` (refused for a whole-project reset).
Backed by `src/remote-close.ts`'s `planRemoteClose`/`executeRemoteClose`
— ported from dev-loop's identical module, minus its PR-closing
capability: this repo never opens a PR (that's downstream of the
`pipeline:research` → `pipeline:dev` handoff, dev-loop's job), so there
is no local data to recover a PR URL from and `planRemoteClose` here is
trivially synchronous (no filesystem read at all).

**Closing the Jira ticket** discovers a target transition by status
*category* (`statusCategory.key === "done"`), not a hardcoded status
name — same rationale as `JiraClient.closeTicket`'s own doc comment
(`src/jira-client.ts`): no single "Closed" name is guaranteed across
every project's workflow, but `statusCategory` is stable and built-in. If
more than one done-category transition is offered, the first one is
used, and the summary always names which one — so a wrong pick is
immediately visible.

If the ticket isn't already done and *no* done-category transition is
offered directly, `closeTicket` walks up to `MAX_INTERMEDIATE_HOPS` (4)
intermediate statuses first — discovered live on TARS-1467, whose Story
workflow needed *two* hops (Code Review → Development Complete →
Deployed to INT) before a done-category transition finally appeared. At
each step it looks for a single transition whose target status name
matches `/complete|done|closed?|resolved?|ready|release|deploy|verified?
|approved?|accepted|delivered|shipped|merged/i` and does *not* match
`/block|reject|reopen|restart/i` (never hops toward something that would
set the ticket back), transitions to it, then re-checks for a
done-category transition from the new status — repeating until one
appears or the bound is hit. The summary's `jiraDetail` on a "closed"
result names the full path taken (e.g.
`"Development Complete -> Deployed to INT -> Closed"`), so the exact
route is always visible, never silent.

This is deliberately generic across issue types rather than configured
per project/issue-type: the live transitions list at each step is
already ground truth for what that specific ticket can do next, so a
Task's short workflow reaches done in 0-1 hops on its own and a Story
gated behind several review/deploy steps just takes more hops through
the same logic — no per-type branching needed.

If, at any step, more than one transition looks like forward progress or
none does, `closeTicket` refuses to guess and reports `no-transition`
immediately. Exhausting all `MAX_INTERMEDIATE_HOPS` hops without
reaching a done-category status also reports `no-transition`. Either
case likely means the workflow needs a human to walk it through Jira's
UI the rest of the way.

**Closing the mirror Issue** uses reason `not_planned`, mapped to gh's
own `"not planned"` flag value by `toGhCloseReason` (`src/github-client
.ts`). Idempotent: an already-closed Issue is a safe no-op.

**Each of the two (Jira, Issue) is attempted independently** — one
failing is recorded as `error` in the printed summary and never blocks
the other, the same error-isolation stance dev-loop's `reconcile.ts`
already takes per-ticket.

**Credentials**: `--close-remote` needs real `JIRA_BASE_URL`/
`JIRA_EMAIL`/`JIRA_API_TOKEN` and `gh` auth — use
`npm run reset-project:remote` (which runs with `--env-file=.env`), not
the plain `reset-project` script, which deliberately never loads `.env`
so a purely local reset never needs credentials to exist at all. Real
Jira/GitHub clients are constructed in `reset-cli.ts` only inside the
`--close-remote` branch, never for a local-only run.

**Agent policy**: an agent invoking `--close-remote` for a real
(non-`--dry-run`) run must always confirm with the human in chat first —
every time, regardless of Claude Code's permission-mode settings for
that session. This is enforced as agent behavior, not as script logic,
so it holds no matter how permissions are configured.
`--dry-run --close-remote` needs no such confirmation — it makes no
network calls at all (there's no filesystem lookup to do first either,
unlike dev-loop's PR-URL recovery).

### Archiving instead of deleting `runs.jsonl` lines

Removed lines (per-ticket or whole-project) are appended to
`runs/<project>.reset-archive.jsonl` — sibling to the live log,
append-only, plain JSONL (no wrapping envelope, so it stays greppable and
replayable) — *before* the live log is ever rewritten or deleted.
Interrupting a reset between the archive-append and the live-log edit
leaves, at worst, a harmless duplicate in the append-only archive, never
a lost line. `scripts/stats.mjs` never reads the archive file — only the
live `<project>.jsonl` — so archived history never affects stats; it
exists purely as a human-facing safety net.

### Why worktrees aren't swept in whole-project mode

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

### Dry-run first

`--dry-run` prints the exact same plans `planReset()` (and, with
`--close-remote`, `planRemoteClose()`) compute for the real run — never a
separate, potentially-diverging "preview" logic path (see
`src/reset-project.ts`'s and `src/remote-close.ts`'s own top-of-file
comments). Always safe to run before the real thing.

## Dev phase (v1, pre-2.0.0)

`npm run reset-project` (backed by `src/core/reset-project.ts`, wired up via
`.claude/skills/reset-project/SKILL.md`) deterministically deletes this
repo's own local, gitignored pipeline state for one ticket or an entire
project, so it can be run through the pipeline again from scratch.

### Why this exists

Diagnosing a real pipeline bug usually means running a real ticket through
the pipeline live — TARS-1465 was used this way to find and fix two real
bugs (`pollJql.dev` re-polling a landed ticket, and a stuck Code Review
transition on an issue type whose workflow didn't support it). Once the
bug is fixed, the ticket's local history (multiple `runs.jsonl` lines, a
run directory per attempt, raw-usage files, sometimes a leftover worktree)
is no longer representative of a real run and would confuse a genuine
fresh test — `ticket-to-pr`'s own Phase 0 intake reads prior "landed" runs
via `findLandedPrUrl` (see `src/roles/dev/reconcile.ts`), so stale history from a
diagnostic session can produce misleading "already landed" bounces on a
ticket you're trying to test fresh.

Before this script existed, cleaning that up meant hand-rolling
`grep -v`/`rm -rf` against `runs.jsonl` and `.pipeline/<slug>/` each time —
error-prone (easy to `grep -v` the wrong ticket key, or `rm -rf` a sibling
ticket's directory by an over-broad glob) and not repeatable. This script
replaces that with tested, deterministic logic.

A second live test using this same "reset when done" workflow (TARS-1467,
an autonomous auto-promote handoff test) surfaced the same manual-cleanup
problem one level up: closing out the real Jira ticket, GitHub Issue, and
PR was still done by hand, one MCP/`gh` call at a time. `--close-remote`
(see below) and `runs.jsonl` archiving extend this script to cover that
too, deterministically.

### Scope: strictly local and gitignored

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

### What local reset deliberately never touches

- **Jira** — the ticket itself (status, labels, comments, issue type) is
  untouched. A human (or a separate skill/step, or `--close-remote` — see
  below) decides what happens to the real ticket; local reset only ever
  clears *this repo's own local record* of having worked it.
- **GitHub** — no Issue comment, no Issue close, no PR close/merge, no
  branch delete (local or remote). Same reasoning: those are shared,
  visible-to-others state, categorically different from a local scratch
  file only this machine's dev-loop process ever reads.
- **Another ticket's or another project's data** — every deletion is keyed
  by an exact `<TICKET>-` prefix match (never a broader glob), and a
  whole-project reset only ever touches `runs/<THIS-project>.jsonl` and
  `.pipeline/<THIS-project>/`, never a sibling project's directory. Covered
  directly by `test/core/reset-project.test.ts`.

Local reset and remote-closing are deliberately separate code paths
(`src/core/reset-project.ts` vs. `src/core/remote-close.ts`) and separate flags
(default vs. `--close-remote`) — keeping them apart means a local-only
reset is always safe to run speculatively (e.g. from a shell script, or a
future automated "prep for the next test run" step) without ever risking
a write to a shared system, regardless of whether `--close-remote` exists
at all.

### `--close-remote`: closing the real Jira ticket, Issue, and PR

Opt-in, and requires `--ticket` (refused for a whole-project reset —
closing every ticket a project ever touched is out of scope). Backed by
`src/core/remote-close.ts`'s `planRemoteClose`/`executeRemoteClose`, a module
kept entirely separate from `reset-project.ts` on purpose: local reset's
tests use a temp filesystem and zero network; remote-close's tests inject
mock `JiraClient`/`GitHubClient` and touch no filesystem beyond a single
`runs.jsonl` read (to recover the ticket's PR URL via `findOpenPrUrl` in
`src/core/runs-log.ts`, moved there from `src/roles/dev/reconcile.ts` in the
2.0.0 core unification, and widened earlier to also scan
`bounced` lines with a PR attached — a reset should close any open PR for
the ticket, not only one from a run that fully landed).

**Ordering matters and is enforced in `reset-cli.ts`**: the PR-URL lookup
reads `runs.jsonl` *before* `executeReset` archives/trims that same file.
Reversing this would silently lose the ability to find the PR to close.

**Closing the Jira ticket** discovers a target transition by status
*category* (`statusCategory.key === "done"`), not a hardcoded status name
— this Jira instance has no single "Closed" name guaranteed to exist
across every project's workflow, but `statusCategory` is a stable,
built-in property every status carries. If more than one done-category
transition is offered, the first one is used, and the summary always
names which one — so a wrong pick on some other project's workflow is
immediately visible rather than silently wrong.

If the ticket isn't already done and *no* done-category transition is
offered directly, `closeTicket` walks up to `MAX_INTERMEDIATE_HOPS` (4)
intermediate statuses first — discovered live on TARS-1467, whose Story
workflow needed *two* hops (Code Review → Development Complete →
Deployed to INT) before a done-category transition finally appeared. At
each step it looks for a single transition whose target status name
matches `/complete|done|closed?|resolved?|ready|release|deploy|verified?
|approved?|accepted|delivered|shipped|merged/i` and does *not* match
`/block|reject|reopen|restart/i` (so it never hops toward something that
would set the ticket back), transitions to it, then re-checks for a
done-category transition from the new status — repeating until one
appears or the bound is hit. The summary's `jiraDetail` on a "closed"
result names the full path taken (e.g.
`"Development Complete -> Deployed to INT -> Closed"`), so the exact
route is always visible, never silent.

This is deliberately generic across issue types rather than configured
per project/issue-type: the live transitions list at each step is already
ground truth for what that specific ticket can do next, so a Task's short
workflow reaches done in 0-1 hops on its own and a Story gated behind
several review/deploy steps just takes more hops through the same logic
— no per-type branching needed.

If, at any step, more than one transition looks like forward progress
(ambiguous — no config exists to prefer one) or none does,
`closeTicket` refuses to guess and reports `no-transition` immediately —
never silently walked somewhere unintended. Exhausting all
`MAX_INTERMEDIATE_HOPS` hops without reaching a done-category status also
reports `no-transition`. Either case likely means the workflow needs a
human to walk it through Jira's UI the rest of the way.

**Closing the PR** takes the URL directly (what `RunLogLine.pr` actually
holds — `gh pr close <url>` accepts it with no number-parsing needed).
Idempotency was verified live against real `fandango/webtarsthree` state:
`gh issue close`/`gh pr close` on an already-closed item exits 0 with
"already closed" in its output; `gh pr close` on an already-*merged* PR
instead exits 1 with "already merged" — a genuinely different code path,
both mapped to the same `already-closed` result since a merged PR is a
terminal, acceptable outcome for a reset.

**Each of the three (Jira, Issue, PR) is attempted independently** — one
failing is recorded as `error` in the printed summary and never blocks
the other two, the same error-isolation stance `reconcile.ts` already
takes per-ticket.

**Credentials**: `--close-remote` needs real `JIRA_BASE_URL`/
`JIRA_EMAIL`/`JIRA_API_TOKEN` and `gh` auth — use
`npm run reset-project:remote` (which runs with `--env-file=.env`), not
the plain `reset-project` script, which deliberately never loads `.env`
so a purely local reset never needs credentials to exist at all. Real
Jira/GitHub clients are constructed in `reset-cli.ts` only inside the
`--close-remote` branch, never for a local-only run.

**Agent policy**: an agent invoking `--close-remote` for a real
(non-`--dry-run`) run must always confirm with the human in chat first —
every time, regardless of Claude Code's permission-mode settings for that
session. This is enforced as agent behavior, not as script logic, so it
holds no matter how permissions are configured. `--dry-run --close-remote`
needs no such confirmation — it makes no network calls at all.

### Archiving instead of deleting `runs.jsonl` lines

Removed lines (per-ticket or whole-project) are appended to
`runs/<project>.reset-archive.jsonl` — sibling to the live log,
append-only, plain JSONL (no wrapping envelope, so it stays greppable and
replayable) — *before* the live log is ever rewritten or deleted.
Interrupting a reset between the archive-append and the live-log edit
leaves, at worst, a harmless duplicate in the append-only archive, never
a lost line. Neither `scripts/stats.mjs` nor `src/roles/dev/reconcile.ts` ever
reads the archive file — only the live `<project>.jsonl` — so archived
history never affects stats or reconciliation; it exists purely as a
human-facing safety net.

### Why worktrees aren't swept in whole-project mode

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

### Dry-run first

`--dry-run` prints the exact same plans `planReset()` (and, with
`--close-remote`, `planRemoteClose()`) compute for the real run — never a
separate, potentially-diverging "preview" logic path (see
`src/core/reset-project.ts`'s and `src/core/remote-close.ts`'s own top-of-file
comments). Always safe to run before the real thing, including with
`--close-remote` — the PR-URL lookup it performs is a local file read,
never a network call.
