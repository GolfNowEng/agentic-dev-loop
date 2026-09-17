# Config

## Selecting a project (CLI)

`src/main.ts` requires `--project=<name>`, resolved via
`resolveProjectConfigPath()` in `src/config.ts` to
`pipeline.<name>.config.json` at the repo root:

```
npm run loop -- --project=webtarsthree
npm run loop -- --stream --project=webtarsthree
npm run loop -- --project=catalog-ui-public --once
```

`--project <name>` (space-separated) also still works — both forms are
accepted — but `--project=<name>` is the documented convention: it stays
visually unambiguous next to a boolean flag like `--stream`, where
`--stream --project webtarsthree` reads as three tokens with no obvious
grouping.

Omitting `--project`, or naming a project with no matching config file,
fails immediately — before any Jira/GitHub call — with a list of the
projects actually present (every `pipeline.*.config.json` at the repo
root except `pipeline.loop.config.json`, which is loop-mechanics, not a
project). `--config=<path>` still works as a fallback for an arbitrary
path outside the naming convention; passing both `--project` and
`--config` together is an error.

Each terminal's own `--project` selects its own project independently —
running N terminals against N *different* projects is safe, since
per-project on-disk state (`runs/<slug>.jsonl`, `.pipeline/<slug>/...`)
is already namespaced by `repoSlugFromUrl()`. The one remaining gap is
two terminals against the *same* project — see "Future: multiple
concurrent loop instances" below, which this change does not solve.

## Shape

`src/types.ts`'s `Config` interface is the source of truth for
`pipeline.<project>.config.json`'s shape:

- `jira.triggerLabel` / `handoffLabel` — the two pipeline-stage labels a
  ticket moves through: `triggerLabel` (`"pipeline:dev"`) is this repo's
  own poll target — dev-loop's whole territory, end to end: picked up,
  coded, PR'd, code-reviewed, merged. `handoffLabel` (also
  `"pipeline:dev"`) is carried in this repo's Config for shape symmetry
  with research-loop's own Config, even though this repo's runtime never
  performs a label swap itself.
- `jira.claimStatus.{from,to}` — the status transition research-loop uses to
  atomically claim a ticket from an intake epic (race-safe:
  `JiraClient.claimTicket` returns `false`, never throws, if another
  process already claimed it). **dev-loop does not use this** — see
  "Ticket status never reverts" below.
- `jira.repoLabel` — a second, always-paired label naming which repo a
  ticket belongs to (e.g. `"repo:catalog-ui-management"`), ANDed into both
  `pollJql` templates alongside the stage label. Needed because more than
  one target repo can share a single Jira project — `catalog-ui-management`
  and `catalog-ui-public` both file into project `MC` — so the stage label
  alone (`triggerLabel`/`handoffLabel`) can't tell which repo a given
  `pipeline:dev`-labeled ticket actually belongs to; without this, whichever
  dev-loop instance happens to poll first could claim the wrong repo's
  ticket. Unlike `triggerLabel`/`handoffLabel`, `repoLabel` never changes
  across a ticket's lifecycle. A project with only one target repo (e.g.
  `webtarsthree`/`TARS`) doesn't strictly need this for disambiguation, but
  every `pipeline.<project>.config.json` sets it anyway for a uniform
  scheme across projects.
- `jira.pollJql.{refine,dev}` — JQL templates with `{label}` and
  `{repoLabel}` placeholders, filled in by `src/jql.ts`.
- `jira.statusNames.{bounced,prOpen}` — this Jira instance has no literal
  "bounced" status, so these map the loop's terminal outcomes onto whatever
  statuses actually exist in the *child ticket's* (Bug/Story/Task) workflow.
  **Important**: check the child issue type's own transitions
  (`getTransitionsForJiraIssue`) — epics have a separate, simpler workflow
  and will give you the wrong answer.
- `jira.codeReviewFields.{piiField,piiNoImpactOptionId,qaNotesField}` — see
  "Code Review transition screen fields" below. dev-loop-only; this Jira
  instance's Code Review transition (`prOpen`) has a required screen that
  rejects an empty payload.
- `ceilings.{maxRunsPerDay,maxCostPerRunUsd,runTimeoutMin}` — enforced by
  `src/ceilings.ts`; a breach pauses the loop, it never silently continues.
- `autoPromoteLabel` — the field research-loop's own config reads to decide
  whether to auto-swap a ticket straight to `handoffLabel` (`"pipeline:dev"`)
  without human approval, skipping the manual-review gate. This repo's own
  config carries the same field name for shape symmetry with research-loop's
  Config, but dev-loop's own runtime never reads it for a label-swap
  decision — only research-loop's `loop-runner.ts` does.
- `targetRepo.{url,defaultBranch}` — the codebase this pipeline operates on
  (not this pipeline repo itself).
- `targetRepo.path` (optional) — local filesystem path to an existing
  checkout of `targetRepo.url` on this machine. When set, per-run worktrees
  branch directly off it instead of a fresh clone into
  `.pipeline/<slug>/repo` — faster, and its `origin` remote is already the
  real one, so `ticket-to-pr`'s `git push`/`gh pr create` need no extra
  setup. Omit on a machine with no local checkout yet; the clone-based flow
  is used instead.
- `github.repo` — the GitHub repo this project's mirror Issues live in
  (`"owner/repo"` shorthand, passed straight to `gh --repo`). One target
  repo per project config, same granularity as `targetRepo`. Mirrors
  research-loop's own `Config.github.repo` — research-loop creates the
  mirror Issue there; this repo's `GitHubClient` (`src/github-client.ts`)
  reads and writes to the same repo once a ticket crosses to
  `pipeline:dev`.

## Ticket status never reverts

Once research-loop claims a ticket (`To Do` → `In Progress`), status stays
`In Progress` for the rest of the pipeline's lifecycle — no loop ever
transitions it back toward `To Do`. The **label swap**
(`triggerLabel` → `handoffLabel`, on human approval or `autoPromoteLabel`)
is the real human-approval gate; status is not overloaded to also signal
that.

This means dev-loop can't claim a ticket the way research-loop does (there's
no `In Progress` → `In Progress` self-transition in a normal Jira workflow).
Instead, `jira.pollJql.dev` matches on `labels = "pipeline:dev"` directly
plus an `assignee = "{assignee}"` clause (filled from
`JIRA_ASSIGNEE_ACCOUNT_ID`, see below), plus (as of the bounce-loop fix
below) `AND status != "{bouncedStatus}"` (filled from
`jira.statusNames.bounced`) and (as of the landed-loop fix below)
`AND status != "{prOpenStatus}"` (filled from `jira.statusNames.prOpen`)
— the label signals pipeline stage, but a genuine bounce or a landed PR
each need their own exclusion so the very next poll cycle doesn't
immediately re-match and re-run the same ticket. `runLoopIteration`
for `loopKind: "dev"` still has **no atomic claim step at all**: it goes
straight from poll to running the skill. This is safe only because this
MVP assumes exactly one dev-loop instance is ever running against a
project at a time.

**Bounce-loop bug, fixed:** before this exclusion clause existed, a
bounced ticket (status transitioned to `statusNames.bounced`, e.g.
"Blocked") kept matching `pollJql.dev` every single poll cycle
(`postRunDelaySec` = 5s) since nothing about the JQL's own match criteria
ever changed on a bounce — only the label-based design (`triggerLabel`/
`handoffLabel`) changed anything, and a bounce never touches the label.
Confirmed live on TARS-1462: 5 near-identical bounces in ~14 minutes,
~$2.3 total cost, until the process was killed by hand. See
`CHANGELOG.md`'s entry for this fix and research-loop's
`docs/future-enhancements.md`'s "dev-loop bounce-loop bug" entry for the
full incident writeup and the tradeoff this fix resolves.

**Landed-loop bug, fixed:** the same shape of bug, one status over. A
landed PR transitions the ticket to `statusNames.prOpen` (e.g. "Code
Review") per `loop-runner.ts`'s Phase-5 write, but nothing excluded that
status from `pollJql.dev` either, so a ticket kept re-matching the poll
after its PR was already open — same label, same assignee, status now
"Code Review" instead of "Blocked" but still `!= "Blocked"`. Each
re-poll correctly diagnosed "PR already open, nothing to do" at Phase 0
intake and bounced with `failure_category: "blocked"`, but that
diagnosis itself costs a full run. Confirmed live on TARS-1465: 5
consecutive re-runs over ~35 minutes after PR #431 landed, ~$3 total
cost, each one re-discovering and re-reporting the same already-landed
state before the fix. See `CHANGELOG.md`'s entry for this fix.

**Future: multiple concurrent loop instances.** Running more than one
research-loop or dev-loop terminal against the same project at once has no
coordination mechanism today and would race. A real fix would need
something like a per-instance label (e.g. `Runner1`/`Dev1`, incrementing per
instance) checked and set at pickup time, or each loop process being aware
of how many sibling instances are running. Not built — noted here so it's
not forgotten if this pipeline needs to scale beyond one terminal per loop.
`jira.repoLabel` (above) is a related but distinct concern — it disambiguates
*which repo* within a shared Jira project, not concurrent instances of the
*same* project/repo pair; the latter is still unsolved and still races.
Concretely: `repoLabel` prevents a `catalog-ui-management`-scoped dev-loop
instance from grabbing a `catalog-ui-public` ticket, but running two
dev-loop instances both scoped to `catalog-ui-management` at once still
races exactly as described above. `--project <name>` (`CHANGELOG.md`,
2026-09-16) makes N-*different*-projects-concurrent safe, but doesn't
touch this gap — tracked as its own enhancement in research-loop's
`docs/future-enhancements.md` ("Concurrent loop instances against the
*same* project (N-per-project)"), since that's this pipeline's shared
holding pen for unimplemented ideas.

## Assignee bookkeeping

Both loops check the ticket's assignee right when they pick it up: if it's
currently unassigned, they assign it to a configured human via
`JiraClient.assignTicket`. If it's already assigned to anyone, it's left
alone — this is "assign if unassigned," not "reassign to force ownership."

The human's Jira account ID (`JIRA_ASSIGNEE_ACCOUNT_ID`) lives in `.env`, not
`pipeline.<project>.config.json` — it's a per-machine/per-runner-identity
setting like `JIRA_EMAIL`/`JIRA_API_TOKEN`, not per-project wiring. Read via
`assigneeAccountIdFromEnv()` in `src/jira-client.ts`, same pattern as
`credentialsFromEnv()`. Find your own account ID via the Atlassian REST API
(`GET /rest/api/3/myself`) or your Jira profile URL.

The assign call is wrapped in try/catch and surfaced via the existing
`jiraSyncError` result field — a failed assignment never blocks the actual
work or crashes the loop.

## A landed dev-loop verdict never moves the epic

TARS-1349's real Jira run (the first end-to-end dev-loop pass) landed a PR
but never actually moved the ticket to Code Review — `moveToEpic` ran, but
nothing ever called `transitionStatus` for a landed outcome, so the
transition itself was simply missing from the code, not rejected by Jira.
That was fixed the same night — but the first fix also moved the ticket's
**epic** on a landed verdict, which turned out to be its own bug: at the
time, research-loop's spec-review epic ("Pipeline: Review") already meant
"refined spec is awaiting human approval," and landing a dev-loop PR there
too overloaded that same epic to mean two different things depending on
which ticket you were looking at — confirmed confusing on the real board
(landed PRs and spec-review tickets both showed the same epic name, with
no way to tell them apart without opening each one). That epic no longer
exists at all now (epics were retired system-wide in favor of a Jira label
trigger — see `CHANGELOG.md`) — but the underlying fix stands regardless
of naming.

Fixed by removing the epic move entirely for a landed dev-loop verdict —
`decideEpicMove` used to return `null` whenever `loopKind === "dev"`,
regardless of outcome; that function (and the epic-move call site
entirely) has since been deleted outright, since no loop moves anything
epic-or-label-shaped on a landed dev-loop verdict at all. A landed ticket
stays at whatever label it already carries (`handoffLabel`,
`"pipeline:dev"`); **status alone** — `In Progress` → `Code Review` — is
the "needs code review" signal now. research-loop's own landed/ready
verdicts still swap the label normally (`triggerLabel` → `handoffLabel`,
on `autoPromoteLabel` — the real human-approval gate, unrelated to this
fix; a non-auto-promoted verdict leaves the ticket in place, carrying
`triggerLabel`).

## Code Review transition screen fields

Separately: this Jira instance's `statusNames.prOpen` transition ("Ready
for Code Review") has `hasScreen: true` — a required Jira UI screen with
PII/security and QA-notes fields. The interactive `push-branch` skill
(`~/.claude/skills/push-branch/SKILL.md`) already handles this by hand
today, by sending specific field values alongside the transition request;
`runLoopIteration` now mirrors that same write for a **landed dev-loop**
verdict only (never for research-loop, which has no PR to review):

- `jira.codeReviewFields.piiField` (`customfield_13504`, "Covered
  Information Data Inventory") is set to `[{ id: piiNoImpactOptionId }]` —
  unconditionally declaring **"No Impact."** This mirrors push-branch's own
  behavior exactly; neither push-branch nor this pipeline performs a real
  PII/security assessment of the diff. That's a known gap, not solved here
  — if this pipeline ever handles a project where PII impact is a real
  possibility, this needs actual assessment logic, not a hardcoded default.
- `jira.codeReviewFields.qaNotesField` (`customfield_14226`, "QA Notes") is
  a rich-text field — Jira rejects a plain string for it ("Operation value
  must be an Atlassian Document"), confirmed against a real transition
  attempt — so it's set to a short Atlassian Document (ADF)
  (`buildQaNotesAdf()` in `src/loop-runner.ts` — one paragraph per line,
  built purely from the verdict's PR URL and verify-loop count), not from
  anything the skill writes — no `SKILL.md`/verdict.json contract change.

`JiraClient.transitionStatus` takes an optional third `fields` argument for
this — omitted entirely (not sent as `{}`) when a transition needs none
(e.g. the `bounced` transition), so a transition with no screen requirement
isn't given an unnecessary payload.

## Startup-time merge-reconciliation pass

At the top of every poll cycle (before `runLoopIteration`), `main.ts`
runs `reconcileMergedTickets` (`src/reconcile.ts`): finds every ticket at
`handoffLabel` + `statusNames.prOpen` (Code Review) via a new
`JiraClient.pollAllMatching` query, resolves each one's PR URL from the
most recent `"landed"` line in `runs/<slug>.jsonl` for that ticket key,
and checks the real merge state via `gh pr view <url> --json
state,mergedAt`. For any that merged, closes the mirror GitHub Issue
(`state_reason: "completed"`) via `GitHubClient.closeIssue` — but does
**not** touch the Jira ticket's status or label. A human still closes the
Jira ticket by hand; this pass exists only so the GitHub Issue doesn't
stay open indefinitely after a merge that happened while dev-loop was
offline (GitHub's own `Closes #N` convention auto-closes the Issue on a
merge that happens while dev-loop is *running*, but a merge missed while
offline needs this catch-up).

This is a narrower scope than the original Jira-label-trigger design
sketched (`pipeline:dev` → `pipeline:merged`, both systems) — that design
depended on a `stageLabels`/`pipeline:pr-open` label scheme that was
never built (see research-loop's `docs/future-enhancements.md`'s
checkpoint section). Reopening the full label-based version is tracked
there, not here.

A ticket with no `"landed"` line in its own `runs.jsonl` (e.g. it reached
Code Review through a means this pass can't trace a PR URL from) is
recorded as a per-ticket error and skipped, not a crash — the pass keeps
checking every other candidate ticket regardless. Idempotent by
construction: `GitHubClient.closeIssue` is itself a safe no-op on an
already-closed issue, so re-running this pass on a ticket whose Issue is
already closed just re-confirms the merge and reports it closed again,
without erroring.

## Appendix A (Jira wiring)

Every Jira-specific value above starts as the literal placeholder string
`"___"` in a fresh `pipeline.<project>.config.json`. `findPlaceholders()` /
`assertNoPlaceholders()` in `src/config.ts` detect leftover placeholders —
`RealJiraClient` refuses to make a Jira call while any remain. Filling these
in for a real project means: confirming the three pipeline label strings
(`triggerLabel`, `handoffLabel`, `repoLabel`) and checking the *child
ticket* workflow for real status names.

## Adding a new project

1. Copy an existing `pipeline.<project>.config.json` to
   `pipeline.<new-project>.config.json`.
2. Fill in that project's own label strings, statuses, JQL, `targetRepo`,
   and `github.repo` (the mirror Issue repo, same granularity as
   `targetRepo`).
3. Run it via `npm run loop -- --project=<new-project>` —
   `resolveProjectConfigPath()` finds it automatically by the naming
   convention above; no code changes required.

No code changes required. The project's **repo slug** — used to namespace
`runs/<slug>.jsonl` and `.pipeline/<slug>/...` so multiple projects can
coexist under one `dev-loop` checkout — is derived from `targetRepo.url` by
`repoSlugFromUrl()` in `src/config.ts` (e.g. `"webtarsthree"` from
`git@github.com:fandango/webtarsthree.git`), not a separate config field.
