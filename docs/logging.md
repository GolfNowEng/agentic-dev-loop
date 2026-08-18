# Logging

## runs/&lt;project&gt;.jsonl — audit trail

Append-only, one JSON line per completed loop iteration, written by
`appendRunLog()` in `src/runs-log.ts` — this module is the single writer;
it never rewrites or truncates. Namespaced per project (via the repo slug,
see `docs/config.md`) so multiple projects' history can coexist. Gitignored
(`runs/`) — this is local run data, not tracked source.

Schema: `RunLogLine` in `src/types.ts` — ticket, skill, skill_version,
model, started/ended timestamps, outcome, phase_reached, red_confirmed,
verify_loops, retries, failure_category, detail, pr, cost_usd, tokens
(`pr` and TDD fields are always null/zero for this repo's runs — they only
apply to `dev-loop`).

## .pipeline/&lt;slug&gt;/ — per-run scratch space

- `.pipeline/<slug>/repo/` — used only when `targetRepo.path` is **not**
  set in config: a shared `git clone` of the target repo, kept current with
  `git fetch` **only**. No run ever checks out a branch or resets this
  directory directly — a human can `cd` into it at any time without a
  background run pulling the rug out from under them. When `targetRepo.path`
  **is** set (a local checkout already exists on this machine), worktrees
  branch directly off that path instead and this directory is never created.
- `.pipeline/<slug>/worktrees/<TICKET>-<RUN_ID>-ground/` — this run's own
  isolated, detached `git worktree` off `targetRepo.path` (or `repo/` in the
  fallback case), created at the start of Ground and removed unconditionally
  (hard gate) before the run's Cleanup completes — see `docs/skills.md`.
  `ticket-refine` never branches or commits here either; it's read-only by
  convention, just isolated per run.
- `.pipeline/<slug>/runs/<TICKET>-<RUN_ID>/` — one directory per run:
  - `progress.jsonl` — append-only phase-transition log the skill writes
    *while running* (phase_start/phase_end/note events for
    triage/interpret/ground/attack/scope/blocked-check/synthesize/verify),
    so a future dashboard can show live progress without parsing model
    output.
  - `verdict.json` — the skill's final self-report (see `docs/skills.md`).

Also gitignored (`.pipeline/`) — entirely local working state.

## The always-emitted result line

Whatever step a run ends at, the skill emits exactly one line — to stdout,
as `progress.jsonl`'s final event, and as `verdict.json`'s `detail` field:

- `RESULT: ready — refined ticket written`
- `RESULT: bounced (<failure_category>) — <one-line reason with evidence>`
- `RESULT: error — <what went wrong>` (tooling/environment failures only)

This is the one line a human skimming a terminal, or a future dashboard,
needs to read to know what happened — no other file required.

## npm run stats

`scripts/stats.mjs` rolls up `runs/<project>.jsonl` into a landed/bounced/
error/killed breakdown with percentages, a `failure_category` histogram,
and total cost — the "are we succeeding over time" view. ("landed" here
reflects the shared `RunOutcome` type; this repo's own passing outcome,
`ready`, is normalized to it by the loop runner.)

```
npm run stats                              # last 7 days, webtarsthree
npm run stats -- --project webtarsthree --days 30
```
