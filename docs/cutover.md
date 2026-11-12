# Cutover runbook: v1 to 2.0.0

The manager confirms every step. Nothing here runs unattended. Steps marked
**ask before** change shared state (Jira, the filesystem, GitHub) and need an
explicit yes first. Paths below are placeholders; substitute your own.

```
DEV=~/Desktop/Repos/dev-loop
RESEARCH=~/Desktop/Repos/research-loop
```

## 1. Stop v1 for webtarsthree

Stop the v1 `npm run loop` processes for that project in both repos
(`$DEV` and `$RESEARCH`), then verify none remain:

```
pgrep -fl "src/main.ts"
```

No output means stopped. Both scripts below also check this and refuse to
write while a loop runs.

## 2. Relabel refined-but-unpromoted tickets

Needs `.env` (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,
JIRA_ASSIGNEE_ACCOUNT_ID). Selects tickets labelled `pipeline:research` and
`<jira.repoLabel>`, In Progress, whose latest research comment is a
`✅ research-loop -` comment authored by JIRA_ASSIGNEE_ACCOUNT_ID.

Dry run (safe):

```
cd $DEV && npm run cutover:relabel -- --project webtarsthree
```

It prints each key, its labels, the dev label to add
(`roles.dev.triggerLabel`), and a SHA-256 of the sorted keys.

**Ask before** `--write`. It only adds the label, never removes one:

```
cd $DEV && npm run cutover:relabel -- --project webtarsthree --write --confirm <sha256 from the dry run>
```

## 3. Move the v1 folders

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

## 4. One real ticket, end to end

Run one real ticket through the 2.0.0 worker
(`npm run loop -- --project webtarsthree`) and watch it to a PR.

## 5. Manager confirms

Review the PR, the run logs and `npm run stats`. Proceed only on a yes.

## 6. Tag, archive, merge

Each of these is outward-facing. **Ask before** each one:

- Tag the last v1 `main` commit: `git tag v1-final <sha>`
- Archive the research-loop repo on GitHub.
- Merge `feat/v2-monolith`, then set the `[2.0.0]` date in `CHANGELOG.md`
  to the merge date (not before).
