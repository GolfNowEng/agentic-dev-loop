# Logging

> Merged in dev-loop 2.0.0: one repo, two phases. `## Research phase` is the
> former research-loop doc (`--phase research`); `## Dev phase` is the former
> dev-loop doc (`--phase dev`). Wording inside each section still describes its
> repo as it was; "this repo" / "the sibling repo" there means that phase, and
> paths like `src/types.ts` map to `src/core/` and `src/roles/<phase>/` now.
> See `docs/migration-ledger.md`.

## Research phase

### runs/&lt;project&gt;.jsonl — audit trail

Append-only, one JSON line per completed loop iteration, written by
`appendRunLog()` in `src/runs-log.ts` — this module is the single writer;
it never rewrites or truncates. Namespaced per project (via the repo slug,
see `docs/config.md`) so multiple projects' history can coexist. Gitignored
(`runs/`) — this is local run data, not tracked source.

Schema: `RunLogLine` in `src/types.ts` — ticket, skill, skill_version,
model, started/ended timestamps, outcome, phase_reached, red_confirmed,
verify_loops, retries, failure_category, detail, pr, cost_usd, tokens
(`pr` and TDD fields are always null/zero for this repo's runs — they only
apply to `dev-loop`), plus two optional fields: `log_version` (schema
version this line was written under — `"1.1"` as of the `size_trajectory`
field below; a line with no `log_version` at all is implicitly `"1.0"`,
never backfilled) and `size_trajectory` (shadow-mode size telemetry —
`step4_tshirt`, `delta`, `final_score`, written by `verifier-agent` on a
passing run and carried through from `verdict.json` unchanged — see
`docs/skills.md`). **Pure telemetry**: nothing reads or acts on
`size_trajectory` yet. It exists so enough real-run history accumulates to
later decide whether it should replace the Definition-of-ready checklist's
items 4/8 — see `docs/future-enhancements.md`'s size-score entry for what
that would require and why it isn't built yet. A malformed
`size_trajectory` in `verdict.json` is dropped (not persisted) by
`parseSizeTrajectory` in `src/verdict.ts` before it ever reaches this
file — it can never flip a run's `outcome`.

### .pipeline/&lt;slug&gt;/ — per-run scratch space

- `.pipeline/<slug>/repo/` — used only when `targetRepo.path` is **not**
  set in config: a shared `git clone` of the target repo, kept current with
  `git fetch` **only**. No run ever checks out a branch or resets this
  directory directly — a human can `cd` into it at any time without a
  background run pulling the rug out from under them. When `targetRepo.path`
  **is** set (a local checkout already exists on this machine), worktrees
  branch directly off that path instead and this directory is never created.
- `<targetRepo.path>/.claude/worktrees/<TICKET>-<RUN_ID>-ground/` (or
  `.pipeline/<slug>/repo/.claude/worktrees/<TICKET>-<RUN_ID>-ground/` in the
  fallback case) — this run's own isolated, detached `git worktree`,
  **nested inside the checkout it was branched from**, not a sibling path
  elsewhere. Nested so tools like `direnv` that activate by walking up
  from the current directory pick up the target repo's own `.envrc`/local
  env automatically — a sibling directory never could, regardless of any
  `direnv allow`. Created at the start of Ground and removed
  unconditionally (hard gate) before the run's Cleanup completes — see
  `docs/skills.md`. `ticket-refine` never branches or commits here either;
  it's read-only by convention, just isolated per run. Expected to be
  listed in `targetRepo.path`'s own `.git/info/exclude` (machine-local,
  never committed) so it doesn't clutter a human's normal `git status` in
  that repo.
- `.pipeline/<slug>/runs/<TICKET>-<RUN_ID>/` — one directory per run:
  - `progress.jsonl` — append-only phase-transition log the skill writes
    *while running* (phase_start/phase_end/note events for
    triage/interpret/ground/attack/scope/blocked-check/synthesize/verify),
    so a future dashboard can show live progress without parsing model
    output.
  - `verdict.json` — the skill's final self-report (see `docs/skills.md`).

Also gitignored (`.pipeline/`) — entirely local working state.

### The always-emitted result line

Whatever step a run ends at, the skill emits exactly one line — to stdout,
as `progress.jsonl`'s final event, and as `verdict.json`'s `detail` field:

- `RESULT: ready — refined ticket written`
- `RESULT: bounced (<failure_category>) — <one-line reason with evidence>`
- `RESULT: error — <what went wrong>` (tooling/environment failures only)

This is the one line a human skimming a terminal, or a future dashboard,
needs to read to know what happened — no other file required.

### npm run stats

`scripts/stats.mjs` rolls up `runs/<project>.jsonl` into a landed/bounced/
error/killed breakdown with percentages, a `failure_category` histogram,
and total cost — the "are we succeeding over time" view. ("landed" here
reflects the shared `RunOutcome` type; this repo's own passing outcome,
`ready`, is normalized to it by the loop runner.)

```
npm run stats                              # last 7 days, webtarsthree
npm run stats -- --project webtarsthree --days 30
```

## Dev phase

### runs/&lt;project&gt;.jsonl — audit trail

Append-only, one JSON line per completed loop iteration, written by
`appendRunLog()` in `src/core/runs-log.ts` — this module is the single writer;
it never rewrites or truncates. Namespaced per project (via the repo slug,
see `docs/config.md`) so multiple projects' history can coexist. Gitignored
(`runs/`) — this is local run data, not tracked source.

Schema: `RunLogLine` in `src/core/types.ts` — ticket, skill, skill_version,
model, started/ended timestamps, outcome, phase_reached, red_confirmed,
verify_loops, retries, failure_category, detail, pr, cost_usd, tokens.

### .pipeline/&lt;slug&gt;/ — per-run scratch space

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

### The always-emitted result line

Whatever phase a run ends at, the skill emits exactly one line — to stdout,
as `progress.jsonl`'s final event, and as `verdict.json`'s `detail` field:

- `RESULT: landed — PR opened at <url>`
- `RESULT: bounced (<failure_category>) — <one-line reason with evidence>`
- `RESULT: error — <what went wrong>` (tooling/environment failures only)

This is the one line a human skimming a terminal, or a future dashboard,
needs to read to know what happened — no other file required.

### npm run stats

`scripts/stats.mjs` rolls up `runs/<project>.jsonl` into a landed/bounced/
error/killed breakdown with percentages, a `failure_category` histogram,
and total cost — the "are we succeeding over time" view.

```
npm run stats                              # last 7 days, webtarsthree
npm run stats -- --project webtarsthree --days 30
```

### v2 path layout

All paths come from `src/core/paths.ts` (validated segments, contained under
the repo root). v2: `runs/v2/<project>.jsonl`; run dirs
`.pipeline/v2/<project>/<session>/<ticket>/<phase>-<runId>/` (raw usage is
`usage.json` inside); clone `.pipeline/v2/<project>/repo`; `.../sessions`.
v1 archive: `runs/v1/<role>/<project>.jsonl`. The `--phase` runners still use
the legacy `runs/<slug>.jsonl` and `.pipeline/<slug>/` via `legacy*` functions
until they are removed.
