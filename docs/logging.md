# Logging

## runs/&lt;project&gt;.jsonl — audit trail

Append-only, one JSON line per completed loop iteration, written by
`appendRunLog()` in `src/runs-log.ts` — this module is the single writer;
it never rewrites or truncates. Namespaced per project (via the repo slug,
see `docs/config.md`) so multiple projects' history can coexist. Gitignored
(`runs/`) — this is local run data, not tracked source.

Schema: `RunLogLine` in `src/types.ts` — ticket, skill, skill_version,
model, started/ended timestamps, outcome, phase_reached, red_confirmed,
verify_loops, retries, failure_category, detail, pr, cost_usd, tokens.

## .pipeline/&lt;slug&gt;/ — per-run scratch space

- `.pipeline/<slug>/repo/` — used only when `targetRepo.path` is **not**
  set in config: a shared `git clone` of the target repo, kept current with
  `git fetch` **only**. No run ever checks out a branch or resets this
  directory directly — a human can `cd` into it at any time without a
  background run pulling the rug out from under them. When `targetRepo.path`
  **is** set (a local checkout already exists on this machine, with its
  real `origin` remote already in place for push/PR), worktrees branch
  directly off that path instead and this directory is never created.
- `<targetRepo.path>/.claude/worktrees/<TICKET>-<RUN_ID>/` (or
  `.pipeline/<slug>/repo/.claude/worktrees/<TICKET>-<RUN_ID>/` in the fallback
  case) — this run's own isolated `git worktree`, **nested inside the
  checkout it was branched from**, not a sibling path elsewhere, on its
  own branch (`<TICKET>-<slug>`). Nested so tools like `direnv` that
  activate by walking up from the current directory pick up the target
  repo's own `.envrc`/local env automatically — a sibling directory never
  could. Removed once the run's Cleanup runs — unconditionally if the run
  landed or bounced with everything committed, but deliberately **kept**
  if the run bounces with uncommitted in-progress work, so a human can
  inspect exactly what was tried (see `docs/skills.md`). Expected to be
  listed in `targetRepo.path`'s own `.git/info/exclude` (machine-local,
  never committed) so it doesn't clutter a human's normal `git status` in
  that repo.
- `.pipeline/<slug>/runs/<TICKET>-<RUN_ID>/` — one directory per run:
  - `progress.jsonl` — append-only phase-transition log a skill writes
    *while running* (phase_start/phase_end/note events), so a future
    dashboard can show live progress without parsing model output.
  - `verdict.json` — the skill's final self-report (see `docs/skills.md`).

Also gitignored (`.pipeline/`) — entirely local working state.

## The always-emitted result line

Whatever phase a run ends at, the skill emits exactly one line — to stdout,
as `progress.jsonl`'s final event, and as `verdict.json`'s `detail` field:

- `RESULT: landed — PR opened at <url>`
- `RESULT: bounced (<failure_category>) — <one-line reason with evidence>`
- `RESULT: error — <what went wrong>` (tooling/environment failures only)

This is the one line a human skimming a terminal, or a future dashboard,
needs to read to know what happened — no other file required.

## npm run stats

`scripts/stats.mjs` rolls up `runs/<project>.jsonl` into a landed/bounced/
error/killed breakdown with percentages, a `failure_category` histogram,
and total cost — the "are we succeeding over time" view.

```
npm run stats                              # last 7 days, webtarsthree
npm run stats -- --project webtarsthree --days 30
```
