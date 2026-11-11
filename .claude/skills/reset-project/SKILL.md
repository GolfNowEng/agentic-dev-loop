---
name: reset-project
description: Deterministically wipe this repo's own v2 pipeline state (one role or both) for one ticket, or an entire project, so it can be re-run from scratch. Local reset never touches Jira/GitHub/git history; the optional --close-remote flag additionally closes the real Jira ticket, its mirror GitHub Issue, and any open PR -- see the confirmation-first policy below before ever passing it.
---

# reset-project

One skill, one script, for both roles. It resets this repo's **v2** state
(`runs/v2/<project>.jsonl` records and `.pipeline/v2/<project>/` run
dirs), with `--role research|dev|all` picking the role (default `all`).
Paths are always repo-root-relative, so the directory you run it from does
not matter. **v1 history is never touched**, in either layout:
`runs/v1/`, `.pipeline/v1/`, the pre-cutover `runs/<slug>.jsonl` and
`.pipeline/<slug>/`, `research-loop/runs/`, `research-loop/.pipeline/`.

## Arguments

`$ARGUMENTS` — `--project <name>` (required) plus one of:
- `--ticket <KEY>` — reset just this ticket within the project.
- (nothing) — reset the WHOLE project. Requires `--yes`.

Optional:
- `--role research|dev|all` (default `all`) — `research`/`dev` deletes only
  that role's `<role>-<RUN_ID>` run dirs and archives only the records that
  contain a phase of that role (or a pending `resume` of it); `all` archives
  every record for the ticket (or project).
- `--dry-run` (print the plans, act on nothing), `--yes` (skip the
  whole-project confirmation gate), `--close-remote` (see below — requires
  `--ticket`, refused for a whole-project reset).

## What this is for

This is a **deterministic script**, not agent judgment — deleting local
pipeline state, or closing a real ticket/Issue/PR, should never depend on
an LLM's read of the situation on a given day. When you need to start a
ticket (or a whole project) fresh — most often after diagnosing and
fixing a bug via a live ticket, the way TARS-1465 was used and then wiped
clean — run the script directly. Do not improvise the equivalent by hand
with `rm -rf`/`grep -v`/one-off `gh`/Jira calls — this script already
handles the "don't touch any other ticket's data," "don't delete another
project's `.pipeline/` directory," and "don't silently drop a failed
remote close" cases correctly, with test coverage
(`test/core/reset-project.test.ts`, `test/core/reset-cli.test.ts`,
`test/core/remote-close.test.ts`) backing every guarantee.

## Local reset: what it does and does not do

Local reset (no `--close-remote`) is scoped **strictly to this repo's own
local, gitignored v2 state** for the chosen role(s) — see
`docs/reset.md` for the exact rationale. It never touches Jira, GitHub, or
the target repo's git history, and never touches another ticket's or
another project's data. It also never swaps the ticket's
`pipeline:research`/`pipeline:dev` label.

## `--close-remote`: closing the real ticket, Issue, and PR

**Requires `--ticket`** — remote-closing is refused for a whole-project
reset, since closing every ticket a project has ever touched is out of
scope. When passed:

1. Closes the Jira ticket via a `done`-category status transition (first
   one found, by name if more than one exists — the summary always names
   which transition was actually used). If no done-category transition is
   offered directly, walks up to 4 intermediate hops through single
   unambiguous forward-progress-looking statuses first (e.g. Code Review
   → Development Complete → Deployed to INT → Closed — the exact
   two-hop case hit live on TARS-1467's Story workflow). Generic across
   issue types — a Task's short workflow just needs 0-1 hops, a Story
   gated behind review/deploy steps needs more, same logic either way.
   Never guesses when more than one hop candidate is offered at any step,
   or the hop bound is exhausted — reports `no-transition` instead.
   Posts one comment first, noting this was a test/reset ticket closed as
   not-planned.
2. Closes the mirror GitHub Issue with reason `not planned`.
3. Closes the PR recorded for the ticket in local run history: the latest
   `landed` or `bounced` dev phase with a PR in `runs/v2/<project>.jsonl`,
   else the latest such line in the v1 dev log. It is read before any
   record is archived. Research never opens a PR, so a ticket with only
   research history reports "no open PR found". `--role` does not change
   what `--close-remote` closes.

Each of the three is attempted independently; one failing never blocks
the other two. The printed summary distinguishes `closed` / `already-
done`/`already-closed` (a safe no-op) / `no-transition` (the ticket isn't
done, no done-category transition is offered, and no unambiguous
intermediate hop path within the bound reaches one either — likely needs
a human to walk it through Jira's UI; never silently treated as success)
/ `error` (with the actual failure message) for each item.

**Needs real Jira/GitHub credentials** — invoke via
`npm run reset-project:remote` (loads `.env`), not the plain
`reset-project` script (which deliberately never loads `.env`, so a
purely local reset never requires credentials to exist at all).

**Agent policy — always confirm first.** If you are an agent about to
invoke `--close-remote` for a real (non-`--dry-run`) run: always ask the
human to confirm in chat first, every time, regardless of Claude Code's
permission-mode settings for this session. `--dry-run --close-remote` is
always safe to run without asking (it only reads local files and prints
what *would* happen — no network calls at all). This policy lives in the
agent's own behavior, not in the script, precisely so it applies no
matter how permissions are configured.

## Running it

From the repo root (any cwd works; paths don't depend on it):

```bash
# Local-only: see what would be deleted, without deleting anything:
npm run reset-project -- --project=webtarsthree --ticket=TARS-1465 --dry-run

# Local-only: actually delete it (both roles):
npm run reset-project -- --project=webtarsthree --ticket=TARS-1465

# Only the research side (dev-* run dirs and dev-only records stay):
npm run reset-project -- --project=webtarsthree --ticket=TARS-1465 --role research

# Whole-project wipe (every ticket) -- requires --yes:
npm run reset-project -- --project=webtarsthree --yes

# Preview a remote close too (safe, no network calls, no confirmation needed):
npm run reset-project:remote -- --project=webtarsthree --ticket=TARS-1465 --close-remote --dry-run

# The real thing -- confirm with the human first if you are an agent:
npm run reset-project:remote -- --project=webtarsthree --ticket=TARS-1465 --close-remote
```

Check the `scope: ... role: ...` line and the paths in the printed plan
before a non-dry run. If the plan warns that a session lock is present,
a worker may be running for the project: stop it first.

## What gets deleted locally (per-ticket)

1. The ticket's records in `runs/v2/<project>.jsonl` that match `--role`
   — appended to `runs/v2/<project>.reset-archive.jsonl` first
   (append-only, never overwritten), then removed from the live log.
   Every other record is preserved, in order.
2. Every `.pipeline/v2/<project>/<session>/<TICKET>/<role>-<RUN_ID>/`
   directory for that ticket and role, in every session.
3. Leftover worktrees under `<targetRepo.path>/.claude/worktrees/` (or the
   v2 clone's when `targetRepo.path` is unset) named `<TICKET>-*`:
   `--role research` only the `-ground` ones (`ticket-refine`'s Ground
   step), `--role dev` only the others, `all` both.

## What gets deleted locally (whole-project, no `--ticket`)

The matching records (every line with `--role all`) are archived, then
removed (the live log is deleted when that empties it), and every matching
run dir of every ticket is deleted. With `--role all` only, session-dir
leftovers are pruned too: `*.lock.adopted-*`, `.acquire.stale-*`,
`.acquire.reclaim-*`, `.acquire.release-*`, `.tmp-*` — never a `*.lock`,
a `*.lock.stale-*`, or `.acquire`. The clone `.pipeline/v2/<project>/repo`
is kept. Worktrees are **not** swept in this mode — see `docs/reset.md`.

## Recovering archived history

`runs/v2/<project>.reset-archive.jsonl` is plain JSONL, one line per
archived record — greppable/replayable the same way the live log is. It is
never read by `stats.mjs`, `reconcile.ts` or the worker, so archived
records never affect stats, reconciliation, attempt counts or the landed
guard; it exists purely as a safety net for a human who wants the
diagnostic history back later.

## After running it

The next worker iteration sees no v2 history for that ticket (or role):
no attempts counted, no pending handoff or resume, no landed-guard hit
from a v2 record. **v1 history still counts**: a ticket with a landed v1
dev run is still skipped by the dev landed guard, and a v1-refined ticket
is still never re-refined, since reset never touches v1 logs.

Local reset only resets *this repo's* local record. If the ticket's Jira
labels or comments still carry a prior run (a handoff label, a refinement
comment), `ticket-refine`'s idempotent re-refinement check treats it as a
re-pickup — reset those in Jira too for a first-pickup-shaped run. With
`--close-remote` the ticket, Issue and PR are closed instead.
