# Cutover runbook: v1 to 2.0.0

The manager confirms every step. Nothing here runs unattended. Steps marked
**ask before** change shared state (Jira, the filesystem, GitHub) and need an
explicit yes first. Paths below are placeholders; substitute your own.

```
DEV=~/Desktop/Repos/dev-loop          # the main checkout (v1 code until the merge)
RESEARCH=~/Desktop/Repos/research-loop
V2=~/Desktop/Repos/dev-loop-v2        # the feat/v2-monolith worktree
```

**Not cut over here: `catalog-ui-*`.** Their configs keep the v1 labels
(`pipeline:research` / `pipeline:dev`). They stay idle until their configs
move to versioned labels. Worker mode refuses them (label guard), and they
must never be run with `--phase research|dev` meanwhile: `--phase research`
would hand off with no human gate on v1 labels.

## 1. Stop every v1 loop, for good

Stop **all** v1 `npm run loop` processes in both repos (`$DEV` and
`$RESEARCH`), for **every** project, not only webtarsthree. They stay
stopped for good: the migrate in step 2 moves every project's v1 folders,
and after the merge v1 is gone from `main`. A v1 loop restarted after the
migrate would write a fresh v1 log with an empty landed guard (and rebuild
landed tickets), which the v2 readers then ignore forever.

Verify none remain:

```
pgrep -fl "src/main.ts"
```

No output means stopped. The scripts below also check this and refuse to
write while a loop runs.

## 2. Move the v1 folders

Dry run (prints one `move` line per move, sorted; moves nothing):

```
cd $DEV && npm run cutover:migrate -- --dev-root $DEV --research-root $RESEARCH
```

Everything lands under `$DEV`: `runs/*.jsonl` to `runs/v1/{dev,research}/`,
`.pipeline/<slug>/` to `.pipeline/v1/{dev,research}/<slug>/`.
`runs/v2` and `.pipeline/v2` are never touched. It refuses if any
destination exists or a loop is running, and uses rename only (a
cross-filesystem move is refused).

**Ask before** `--write`:

```
cd $DEV && npm run cutover:migrate -- --dev-root $DEV --research-root $RESEARCH --write
```

## 3. One real ticket, end to end, from the worktree

Run it from the **worktree** (`$V2`), which has the 2.0.0 code. `$DEV` is
still v1 code until the merge in step 6; never start a loop there now.

```
cd ~/Desktop/Repos/dev-loop-v2 && npm run loop -- --project webtarsthree --once
```

`--once` stops after one ticket iteration. Watch it to a PR (research, then
dev, on the same ticket). No ticket has been relabelled yet (step 5), so
the iteration should pick a `pipeline:v2.0.0` research ticket (unless a `pipeline:v2.0.0:dev` ticket is already waiting).

## 4. Manager confirms

Review the PR, the run logs and `npm run stats` (from `$V2`). Proceed only
on a yes.

## 5. Relabel refined-but-unpromoted tickets

Needs `.env` (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,
JIRA_ASSIGNEE_ACCOUNT_ID). Selects tickets labelled `pipeline:research` and
`<jira.repoLabel>`, In Progress, whose latest research comment is a
`✅ research-loop -` comment authored by JIRA_ASSIGNEE_ACCOUNT_ID. It adds
`roles.dev.triggerLabel` (`pipeline:v2.0.0:dev`), which only the 2.0.0 dev
poll matches. It runs after the confirmation on purpose: the worker takes
dev candidates before research, so relabelling earlier would have made the
step 3 run a dev-only run on a relabelled ticket.

Dry run (safe):

```
cd $V2 && npm run cutover:relabel -- --project webtarsthree
```

It prints each key, its labels, the dev label to add, and a SHA-256 of the
sorted keys.

**Ask before** `--write`. It only adds the label, never removes one:

```
cd $V2 && npm run cutover:relabel -- --project webtarsthree --write --confirm <sha256 from the dry run>
```

## 6. Tag, archive, merge

Each of these is outward-facing. **Ask before** each one:

- Tag the last v1 `main` commit: `git tag v1-final <sha>`
- Archive the research-loop repo on GitHub.
- Merge `feat/v2-monolith`, then set the `[2.0.0]` date in `CHANGELOG.md`
  to the merge date (not before).

## 7. Carry the worktree's v2 state into the main checkout

All v2 state so far (the step 3 run, and earlier ones such as TARS-1625's
landed record) lives in the worktree, gitignored: `$V2/runs/v2/` and
`$V2/.pipeline/v2/`. Without it, the dev landed guard and reconcile in
`$DEV` would not know those PRs, and a merged ticket would be rebuilt.

Do this after the merge, **before** removing the worktree and **before**
any loop start from `$DEV`, with no loop running anywhere.

Dry run:

```
cd $DEV && npm run cutover:migrate -- --dev-root $DEV --v2-from ~/Desktop/Repos/dev-loop-v2
```

It prints at most two moves (`runs/v2`, `.pipeline/v2`, each only if it
exists) and refuses if `$DEV` already has either one.

**Ask before** `--write`:

```
cd $DEV && npm run cutover:migrate -- --dev-root $DEV --v2-from ~/Desktop/Repos/dev-loop-v2 --write
```

Only then remove the worktree. From here on, loops start from `$DEV`.
