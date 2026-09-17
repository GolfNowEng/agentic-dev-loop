---
name: reset-project
description: Deterministically wipe this repo's own local pipeline state for one ticket, or an entire project, so it can be re-run from scratch. Never touches Jira, GitHub, or the target repo's git history -- local, gitignored state only (runs/<project>.jsonl, .pipeline/<project>/, this repo's own worktrees under targetRepo.path).
---

# reset-project

## Arguments

`$ARGUMENTS` — `--project <name>` (required) plus one of:
- `--ticket <KEY>` — reset just this ticket within the project.
- (nothing) — reset the WHOLE project: every ticket's `runs.jsonl` history
  and its entire `.pipeline/<slug>/` directory. Requires `--yes`.

Optional: `--dry-run` (print the plan, delete nothing), `--yes` (skip the
whole-project confirmation gate).

## What this is for

This is a **deterministic script**, not agent judgment — deleting local
pipeline state should never depend on an LLM's read of the situation on a
given day. When you need to start a ticket (or a whole project) fresh —
most often after diagnosing and fixing a bug via a live ticket, the way
TARS-1465 was used and then wiped clean — run the script directly. Do not
improvise the equivalent by hand with `rm -rf`/`grep -v` — this script
already handles the "don't touch any other ticket's data" and "don't
delete another project's `.pipeline/` directory" cases correctly, with
test coverage (`test/reset-project.test.ts`) backing that guarantee.

## What this does NOT do

This is scoped **strictly to research-loop's own local, gitignored
state** — see `docs/reset.md` for the exact rationale. It never:

- Transitions, comments on, retypes, or closes the Jira ticket itself.
- Swaps the ticket's `pipeline:research`/`pipeline:dev` label.
- Closes, comments on, or otherwise touches the mirror GitHub Issue.
- Touches another ticket's or another project's data.

If the live Jira ticket or GitHub Issue from a prior test run also need
to be closed out (or its label reset back to `pipeline:research`), do
that separately by hand (or ask a human/agent to) before or after running
this — this skill is local-filesystem-only by design, so that running it
never has a blast radius beyond this machine.

## Running it

```bash
# See what would be deleted, without deleting anything:
npm run reset-project -- --project=webtarsthree --ticket=TARS-1465 --dry-run

# Actually delete it:
npm run reset-project -- --project=webtarsthree --ticket=TARS-1465

# Whole-project wipe (every ticket) -- requires --yes:
npm run reset-project -- --project=webtarsthree --yes
```

## What gets deleted (per-ticket)

1. Every line in `runs/<project>.jsonl` whose `"ticket"` field matches the
   given key — every other ticket's lines are preserved, in order.
2. Every `.pipeline/<slug>/runs/<TICKET>-<RUN_ID>/` directory for that
   ticket (there can be several, one per run attempt).
3. Every `.pipeline/<slug>/raw-usage/<TICKET>-<...>.json` file for that
   ticket.
4. If `pipeline.<project>.config.json`'s `targetRepo.path` is set: any
   leftover `<targetRepo.path>/.claude/worktrees/<TICKET>-<...>/`
   directories for that ticket — this matches
   `<TICKET>-<RUN_ID>-ground` (`ticket-refine`'s own Ground-step worktree
   naming, see `docs/skills.md`) since the match is by `<TICKET>-` prefix,
   not an exact name.

## What gets deleted (whole-project, no `--ticket`)

`runs/<project>.jsonl` is deleted entirely, and `.pipeline/<project>/` is
deleted entirely (every ticket's run dirs and raw-usage files at once).
Worktrees are **not** swept in this mode — see `docs/reset.md` for why
(no safe way to scope "every worktree for this project" without risking
another project's worktree that happens to share the same
`targetRepo.path`).

## After running it

The next research-loop poll cycle for that ticket starts genuinely fresh:
no prior `runs.jsonl` history, no stale `.pipeline/<slug>/runs/` directory,
no leftover Ground-step worktree from an interrupted run. Note this only
resets *this repo's* local record — if the ticket's Jira label is still
`pipeline:dev` (handed off) or its Jira comment/GitHub Issue still carries
a prior refinement, `ticket-refine`'s own idempotent-re-refinement check
(see `SKILL.md`'s "Setup: idempotent re-refinement") will treat it as a
re-pickup, not a first pickup — reset the ticket's label/comments in Jira
too if you want a truly first-pickup-shaped fresh run.
