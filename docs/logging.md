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

- `.pipeline/<slug>/workdir/<slug>/` — the persistent target-repo checkout,
  reset (`git fetch` + `git reset --hard`) at the start of each run.
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
