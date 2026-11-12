# Evals (spec §9.2)

End-to-end scenarios that run the real loop (`npm run loop -- --config
pipeline.eval.config.json --once`) against a private sandbox repo,
`JustinChan-fd/dev-loop-eval-sandbox`, with real Jira tickets in TARS that
carry the `dev-loop-eval` label and a `[dev-loop-eval]` summary prefix.

## Before the first real run: needs the user's go

- **The sandbox repo does not exist yet.** Creating it (`gh repo create`,
  seeded from `poc-stacked-prs/app`) is outward-facing: ask first.
- **A real run costs money.** Each ticket a scenario works is one research
  run (ceiling $15) and one dev run (ceiling $10). `--all` works six
  tickets, so the worst case is about $150. Say what it will cost and get a go
  before running any scenario for real.
- `bash evals/preflight.sh` (live) is also the user's call: it checks gh
  auth, the sandbox repo, and Jira auth.

## Running

```sh
DRY_RUN=1 npm run eval -- clean     # print every outward command, run none
npm run eval -- clean               # one scenario, for real
npm run eval -- --all               # all five, in order; stops at the first failure
node evals/report.mjs               # outcome / phases / cost / minutes per scenario
bash evals/reset.sh                 # list what would be closed
bash evals/reset.sh --write         # close it
```

One scenario per call. `--all` is required for all five. A failed scenario
is never auto-retried: read its grader's JSON line, then decide.

| scenario | setup | passes when |
|---|---|---|
| `clean` | one well-specified ticket | record `landed`, 2 phases, sandbox PR open, RED commit before GREEN |
| `ambiguous` | one vague ticket | research `bounced`, 1 phase, ticket in Blocked, no PR |
| `dev-bounce` | a ticket that points at a doc the repo doesn't have | research landed, dev bounced `spec_ambiguous` |
| `blocked` | ticket B "is blocked by" A, and A has an open sandbox PR | B's record is `skipped-blocked` naming A, no claim, B still To Do |
| `queue` | an ambiguous ticket, then a clean one | two records, the first bounced and the second `landed` |

`dev-bounce` is the least deterministic scenario: research can bounce the
ticket itself.

## Files

- `lib.sh`: `outward` (the one gate for outward commands), `run_to`
  (wall-clock limit), `api` (`gh api` pinned to the sandbox), `jira`,
  `assert_repo`, `assert_clone`.
- `preflight.sh`: the config guard (`config-guard.mjs`, local), then gh,
  sandbox and Jira checks (outward).
- `run.sh`: preflight, then scenario setup, then the loop under `run_to`,
  then the grader.
- `scenarios/*.sh`: the ticket text and setup for each scenario.
- `check-*.mjs`: pure graders, `grade({ records, pr, jira }) -> { pass,
  reasons }` (shared pieces in `grade-lib.mjs`). Run directly, they
  gather real state through `gather.mjs`.
- `jira.mjs`: the only Jira client in `evals/`. Every write refuses a
  non-eval ticket.
- `report.mjs`: the summary table.
- `reset.sh`: closes eval tickets and their sandbox PRs.

## Boundaries (enforced, not convention)

- **Dry run.** With `DRY_RUN=1`, `outward` prints `DRY: <cmd>` and runs
  nothing. Every gh, Jira, loop and grader call in `evals/*.sh` goes
  through it. `test/evals/harness.test.ts` checks this two ways. First,
  it scans the scripts for any gh/curl/npm/claude call outside `outward`.
  Second, it runs the scripts with stub `gh`/`claude`/`curl`/`npm` first
  on PATH and asserts that no stub was called. Dry keys go to
  `.state/keys.dry`, never `.state/keys`.
- **Config.** `preflight.sh`, which `run.sh` calls first, aborts in either
  of two cases: `pipeline.eval.config.json`'s `github.repo` or
  `targetRepo.url` is not the sandbox, or either pollJql lacks
  `AND labels = "dev-loop-eval"`. The production configs exclude that
  label.
- **Jira writes.** `run.sh` exports `DEVLOOP_EVAL_KEYS`, which the
  spawned `claude -p` inherits. While it is set,
  `.claude/hooks/block-non-eval-jira-writes.sh` denies any
  `mcp__atlassian__` write to a key outside the list, and any
  `createJiraIssue` without the `[dev-loop-eval]` prefix.
- **GitHub.** `run.sh` exports `GH_REPO=<sandbox>`. `api` and `reset.sh`
  touch only the sandbox, behind `assert_repo`.
- **Reset.** A ticket is closed only when all three hold: its key is in
  `.state/keys`, it carries the label, and its summary has the prefix.
  Nothing is closed without `--write`.

`.state/` is gitignored. It holds `keys`, `scenarios` (used by
`report.mjs`) and the ticket-text temp files.
