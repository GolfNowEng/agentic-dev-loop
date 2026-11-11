---
name: reset-project
description: Deterministically wipe this repo's own local pipeline state (dev phase or research phase) for one ticket, or an entire project, so it can be re-run from scratch. Local reset never touches Jira/GitHub/git history; the optional --close-remote flag additionally closes the real Jira ticket, its mirror GitHub Issue, and any open PR -- see the confirmation-first policy below before ever passing it.
---

# reset-project

One skill for both phases. Until v2 paths land, each phase keeps its v1
state in its own root: the **dev** phase in this repo's `runs/` and
`.pipeline/`, the **research** phase in `research-loop/runs/` and
`research-loop/.pipeline/`. The same script resets either one -- which one
depends on the directory you run it from (it resolves `runs/`,
`.pipeline/` from its cwd, and `pipeline.<project>.config.json` from its
cwd if any is there, else from the repo root). See
"Running it" below. A `--role research|dev|all` flag that picks the role
for you arrives in Task 14 of the 2.0.0 plan; until then, the cwd is the
role selector.

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

Local reset (no `--close-remote`) is scoped **strictly to this repo's own
local, gitignored state** for the phase whose root you run it from — see
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
3. Closes any open PR found for the ticket in local run history (from
   either a `landed` or a `bounced` run line — any PR the ticket ever
   opened, not only one from a fully-succeeded run). The research phase
   never opens a PR (its run lines always carry `pr: null`), so from the
   research root this step always reports "no open PR found".

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

**Dev phase** (state in this repo's `runs/` and `.pipeline/`), from the
repo root:

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

**Research phase** (v1 state in `research-loop/runs/` and
`research-loop/.pipeline/`): `research-loop/` has no `package.json` any
more, so `npm run` does not work there. Run the same script from
`research-loop/` directly, so it reads research's state (the project config
comes from the repo root; `research-loop/` has no copy since 2.0.0):

```bash
cd research-loop

# Local-only dry run / real run / whole-project wipe:
node ../src/core/reset-cli.ts --project=webtarsthree --ticket=TARS-1465 --dry-run
node ../src/core/reset-cli.ts --project=webtarsthree --ticket=TARS-1465
node ../src/core/reset-cli.ts --project=webtarsthree --yes

# Remote close needs credentials, from the repo root's .env
# (preview is safe; the real one needs human confirmation first):
node --env-file=../.env ../src/core/reset-cli.ts --project=webtarsthree --ticket=TARS-1465 --close-remote --dry-run
node --env-file=../.env ../src/core/reset-cli.ts --project=webtarsthree --ticket=TARS-1465 --close-remote
```

Running from the wrong directory resets the other phase's state (or finds
nothing), so check the `[reset] project:` line and the paths in the
printed plan before a non-dry run.

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
   directories for that ticket — a dev run that bounced with
   `keep_worktree` (see `ticket-to-pr`'s own Cleanup section) can leave
   one behind. The match is by `<TICKET>-` prefix, so it also catches
   research's `<TICKET>-<RUN_ID>-ground` worktrees (`ticket-refine`'s
   Ground-step naming, see `docs/skills.md`).

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
reconciliation (either phase); it exists purely as a safety net for a human who wants
the diagnostic history back later.

## After running it

**Dev phase:** the next dev poll cycle starts genuinely fresh for that
ticket (or project): no prior run history to confuse `ticket-to-pr`'s own
"already landed, nothing to do" intake check, no stale run directories,
no leftover worktree from an interrupted run — and, if `--close-remote`
was used, no lingering open Jira ticket, Issue, or PR either.

**Research phase:** the next research poll cycle for that ticket starts
fresh locally: no prior `runs.jsonl` history, no stale
`.pipeline/<slug>/runs/` directory, no leftover Ground-step worktree.
Local reset only resets *this repo's* local record — if the ticket's Jira
label is still `pipeline:dev` (handed off) or its Jira comment/GitHub
Issue still carries a prior refinement, `ticket-refine`'s own
idempotent-re-refinement check (see its `SKILL.md`, "Setup: idempotent
re-refinement") treats it as a re-pickup, not a first pickup — reset the
ticket's label/comments in Jira too if you want a truly
first-pickup-shaped fresh run. If `--close-remote` was used instead, the
ticket and Issue are closed, so there's no re-pickup to worry about.
