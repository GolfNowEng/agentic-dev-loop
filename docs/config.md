# Config

## Shape

`src/types.ts`'s `Config` interface is the source of truth for
`pipeline.<project>.config.json`'s shape:

- `jira.triggerLabel` / `handoffLabel` — the two pipeline-stage labels a
  ticket moves through. `triggerLabel` (`"pipeline:research"`) is this
  loop's own poll target — fresh, unrefined tickets *and* already-refined
  tickets awaiting Justin's approval both carry it; there is no separate
  label for "awaiting approval" (that distinction is a comment on the
  ticket itself — presence of `Refined Spec — ready for ticket-to-pr` —
  not a label). `handoffLabel` (`"pipeline:dev"`) is dev-loop's poll
  target; this loop only ever *writes* it (on an auto-promoted verdict, by
  swapping it in for `triggerLabel`), never polls for it.
- `jira.repoLabel` — a second, always-paired label naming which repo a
  ticket belongs to (e.g. `"repo:catalog-ui-management"`), ANDed into both
  `pollJql` templates alongside the stage label. Needed because more than
  one target repo can share a single Jira project — `catalog-ui-management`
  and `catalog-ui-public` both file into project `MC` — so the stage label
  alone (`triggerLabel`/`handoffLabel`) can't tell which repo a given
  ticket actually belongs to. Unlike `triggerLabel`/`handoffLabel`,
  `repoLabel` never changes across a ticket's lifecycle. A project with
  only one target repo (e.g. `webtarsthree`/`TARS`) doesn't strictly need
  this for disambiguation, but every `pipeline.<project>.config.json` sets
  it anyway for a uniform scheme across projects. Ported from dev-loop's
  identical field (see dev-loop's `CHANGELOG.md`, 2026-09-16).
- `jira.claimStatus.{from,to}` — the status transition this loop uses to
  atomically claim a ticket (race-safe: `JiraClient.claim` returns `false`,
  never throws, if another process already claimed it).
- `jira.pollJql.{refine,dev}` — JQL templates with `{label}` and `{repoLabel}`
  placeholders, filled in by `src/jql.ts`. This repo only ever polls with `refine`.
- `jira.statusNames.{bounced,prOpen}` — this Jira instance has no literal
  "bounced" status, so these map the loop's terminal outcomes onto whatever
  statuses actually exist in the *child ticket's* (Bug/Story/Task) workflow.
  **Important**: check the child issue type's own transitions
  (`getTransitionsForJiraIssue`) — epics have a separate, simpler workflow
  and will give you the wrong answer.
- `ceilings.{maxRunsPerDay,maxCostPerRunUsd,runTimeoutMin}` — enforced by
  `src/ceilings.ts`; a breach pauses the loop, it never silently continues.
- `autoPromoteLabel` — a ticket label that lets a passing verdict skip
  human approval and swap the ticket straight from `triggerLabel` to
  `handoffLabel`. Without it, a passing verdict leaves the ticket at
  `triggerLabel`, refined and awaiting approval.
- `targetRepo.{url,defaultBranch}` — the codebase `ticket-refine` grounds
  tickets against (not this pipeline repo itself). Read-only for this repo.
- `targetRepo.path` (optional) — local filesystem path to an existing
  checkout of `targetRepo.url` on this machine. When set, per-run worktrees
  branch directly off it instead of a fresh clone into
  `.pipeline/<slug>/repo` — faster, and skips a redundant clone since the
  checkout's `origin` is already the real remote. Omit on a machine with no
  local checkout yet; the clone-based flow is used instead.
- `jira.mentionAccountId` — Jira accountId to @-mention in every Jira-worthy
  comment this repo writes (per the routing rule; see `SKILL.md`'s "Ticket
  content protocol"). Per-project config field, not an env var, since the
  person to mention is a per-project decision (who owns this project's
  tickets), not a per-machine/per-runner-identity setting. Similar to
  `JIRA_ASSIGNEE_ACCOUNT_ID` in purpose but configured separately.
- `github.repo` — `"owner/repo"` shorthand (e.g. `"fandango/webtarsthree"`)
  passed directly to `gh`'s own `--repo` flag. Phase 1 of the Jira-label-trigger
  design (see `docs/future-enhancements.md`): this pipeline mirrors every
  claimed ticket into a GitHub Issue and posts recon/attack/verify/working-note
  content there instead of Jira, per the routing rule in `SKILL.md`. One target
  repo per project config, same granularity as `targetRepo` — derived from the
  same codebase this skill grounds tickets against, not a separate system.

There's no config field for live API testing. `ticket-refine` starts the
target repo's *own* dev server (its own `npm run dev` or equivalent) when a
hypothesis in Ground needs to see what an endpoint actually returns, and
`recon-agent` calls that local instance's proxy routes directly — this
exercises the target repo's real server-side logic, not a bypass, and needs
no separate URL to configure or keep in sync. See `docs/skills.md` for the
lifecycle (who starts/stops it, and the hard gate that it's always stopped
before Ground ends).

## Ticket status never reverts

Once this loop claims a ticket (`claimStatus.from` → `claimStatus.to`,
typically `To Do` → `In Progress`), status stays at `claimStatus.to` for the
rest of the pipeline's lifecycle — this loop never transitions it back
toward `claimStatus.from`, even on a passing verdict. The **label swap**
(`triggerLabel` → `handoffLabel`, on human approval or `autoPromoteLabel`)
is the real human-approval gate; status is not overloaded to also signal
that.

This matters for `dev-loop`, which has no atomic claim step of its own and
instead polls directly for `labels = "pipeline:dev"` (the `handoffLabel`
this loop swaps in) plus an assignee match — no status clause at all, since
the label now signals pipeline stage directly — see dev-loop's own
`docs/config.md` for its "Future: multiple concurrent loop instances" note,
which applies to this loop too (this MVP assumes exactly one research-loop
instance running against a project at a time).

## Assignee bookkeeping

Right after claiming a ticket, this loop checks its assignee: if currently
unassigned, it's assigned to a configured human via `JiraClient.assignTicket`.
If already assigned to anyone, it's left alone — "assign if unassigned," not
"reassign to force ownership."

The human's Jira account ID (`JIRA_ASSIGNEE_ACCOUNT_ID`) lives in `.env`, not
`pipeline.<project>.config.json` — it's a per-machine/per-runner-identity
setting like `JIRA_EMAIL`/`JIRA_API_TOKEN`, not per-project wiring. Read via
`assigneeAccountIdFromEnv()` in `src/jira-client.ts`, same pattern as
`credentialsFromEnv()`. Find your own account ID via the Atlassian REST API
(`GET /rest/api/3/myself`) or your Jira profile URL.

The assign call is wrapped in try/catch and surfaced via the existing
`jiraSyncError` result field — a failed assignment never blocks the actual
work or crashes the loop.

## Appendix A (Jira wiring)

Every Jira-specific value above starts as the literal placeholder string
`"___"` in a fresh `pipeline.<project>.config.json`. `findPlaceholders()` /
`assertNoPlaceholders()` in `src/config.ts` detect leftover placeholders —
`RealJiraClient` refuses to make a Jira call while any remain. Filling these
in for a real project means: confirming the three pipeline label strings
(`triggerLabel`, `handoffLabel`, `repoLabel`), filling in `mentionAccountId`,
and checking the *child ticket* workflow for real status names.

## Adding a new project

1. Copy an existing `pipeline.<project>.config.json` to
   `pipeline.<new-project>.config.json`.
2. Fill in that project's own label strings, statuses, JQL, `targetRepo`,
   and `github.repo` (derived from the same targetRepo).
3. Point the loop runner at that file (`loadConfig(path)` — `loadConfig` has
   no default path on purpose, so there's no implicit single-project
   coupling).

No code changes required. The project's **repo slug** — used to namespace
`runs/<slug>.jsonl` and `.pipeline/<slug>/...` so multiple projects can
coexist under one `research-loop` checkout — is derived from `targetRepo.url`
by `repoSlugFromUrl()` in `src/config.ts` (e.g. `"webtarsthree"` from
`git@github.com:fandango/webtarsthree.git`), not a separate config field.
