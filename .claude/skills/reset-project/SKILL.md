---
name: reset-project
description: Deterministically wipe this repo's own local pipeline state for one ticket, or an entire project, so it can be re-run from scratch. Local reset never touches Jira/GitHub/git history; the optional --close-remote flag additionally closes the real Jira ticket, its mirror GitHub Issue, and any open PR -- see the confirmation-first policy below before ever passing it.
---

# reset-project

## Arguments

`$ARGUMENTS` — `--project <name>` (required) plus one of:
- `--ticket <KEY>` — reset just this ticket within the project.
- (nothing) — reset the WHOLE project: every ticket's `runs.jsonl` history
  and its entire `.pipeline/<slug>/` directory. Requires `--yes`.

Optional: `--dry-run` (print the plans, act on nothing), `--yes` (skip the
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
remote close" cases correctly, with test coverage (`test/reset-project
.test.ts`, `test/remote-close.test.ts`) backing every guarantee.

## Local reset: what it does and does not do

Local reset (no `--close-remote`) is scoped **strictly to dev-loop's own
local, gitignored state** — see `docs/reset.md` for the exact rationale.
It never touches Jira, GitHub, or the target repo's git history, and
never touches another ticket's or another project's data.

## `--close-remote`: closing the real ticket, Issue, and PR

**Requires `--ticket`** — remote-closing is refused for a whole-project
reset, since closing every ticket a project has ever touched is out of
scope. When passed:

1. Closes the Jira ticket via a `done`-category status transition (first
   one found, by name if more than one exists — the summary always names
   which transition was actually used). If no done-category transition is
   offered directly, tries exactly one intermediate hop through a single
   unambiguous forward-progress-looking status first (e.g. Code Review →
   Development Complete → Closed — the exact case hit live on TARS-1467).
   Never guesses when more than one hop candidate is offered, or a second
   hop would be needed — reports `no-transition` instead. Posts one
   comment first, noting this was a test/reset ticket closed as
   not-planned.
2. Closes the mirror GitHub Issue with reason `not planned`.
3. Closes any open PR found for the ticket in local run history (from
   either a `landed` or a `bounced` run line — any PR the ticket ever
   opened, not only one from a fully-succeeded run).

Each of the three is attempted independently; one failing never blocks
the other two. The printed summary distinguishes `closed` / `already-
done`/`already-closed` (a safe no-op) / `no-transition` (the ticket isn't
done, no done-category transition is offered, and no single unambiguous
intermediate hop exists either — likely needs a human to walk it through
Jira's UI; never silently treated as success) / `error` (with the actual
failure message) for each item.

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

```bash
# Local-only: see what would be deleted, without deleting anything:
npm run reset-project -- --project=webtarsthree --ticket=TARS-1465 --dry-run

# Local-only: actually delete it:
npm run reset-project -- --project=webtarsthree --ticket=TARS-1465

# Whole-project wipe (every ticket) -- requires --yes:
npm run reset-project -- --project=webtarsthree --yes

# Preview a remote close too (safe, no network calls, no confirmation needed):
npm run reset-project:remote -- --project=webtarsthree --ticket=TARS-1465 --close-remote --dry-run

# The real thing -- confirm with the human first if you are an agent:
npm run reset-project:remote -- --project=webtarsthree --ticket=TARS-1465 --close-remote
```

## What gets deleted locally (per-ticket)

1. Every line in `runs/<project>.jsonl` whose `"ticket"` field matches the
   given key — archived to `runs/<project>.reset-archive.jsonl` first
   (append-only, never overwritten), then removed from the live log.
   Every other ticket's lines are preserved, in order.
2. Every `.pipeline/<slug>/runs/<TICKET>-<RUN_ID>/` directory for that
   ticket (there can be several, one per run attempt).
3. Every `.pipeline/<slug>/raw-usage/<TICKET>-<...>.json` file for that
   ticket.
4. If `pipeline.<project>.config.json`'s `targetRepo.path` is set: any
   leftover `<targetRepo.path>/.claude/worktrees/<TICKET>-<...>/`
   directories for that ticket — a run that bounced with `keep_worktree`
   (see `ticket-to-pr`'s own Cleanup section) can leave one behind.

## What gets deleted locally (whole-project, no `--ticket`)

The entire prior `runs/<project>.jsonl` is archived to
`runs/<project>.reset-archive.jsonl` first, then deleted, and
`.pipeline/<project>/` is deleted entirely (every ticket's run dirs and
raw-usage files at once). Worktrees are **not** swept in this mode — see
`docs/reset.md` for why (no safe way to scope "every worktree for this
project" without risking another project's worktree that happens to
share the same `targetRepo.path`).

## Recovering archived history

`runs/<project>.reset-archive.jsonl` is plain JSONL, one line per removed
run — greppable/replayable the same way the live log is. It is never read
by `stats.mjs` or `reconcile.ts`, so archived lines never affect stats or
reconciliation; it exists purely as a safety net for a human who wants
the diagnostic history back later.

## After running it

The next `npm run loop -- --project=<name>` poll cycle starts genuinely
fresh for that ticket (or project): no prior run history to confuse
`ticket-to-pr`'s own "already landed, nothing to do" intake check, no
stale run directories, no leftover worktree from an interrupted run —
and, if `--close-remote` was used, no lingering open Jira ticket, Issue,
or PR either.
