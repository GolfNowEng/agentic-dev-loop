# Config

## Shape

`src/types.ts`'s `Config` interface is the source of truth for
`pipeline.<project>.config.json`'s shape:

- `jira.intakeEpics` / `reviewEpic` / `readyEpic` — the three pipeline-stage
  epics a ticket moves through (Intake → Review → Ready).
- `jira.claimStatus.{from,to}` — the status transition a loop uses to
  atomically claim a ticket (race-safe: `JiraClient.claim`/`claimTicket`
  returns `false`, never throws, if another process already claimed it).
- `jira.pollJql.{refine,dev}` — JQL templates with `{epics}` / `{epic}`
  placeholders, filled in by `src/jql.ts`.
- `jira.epicLinkField` — `"parent"` for team-managed Jira projects, or a
  custom field id (e.g. `"customfield_10014"`) for company-managed projects.
- `jira.statusNames.{bounced,prOpen}` — this Jira instance has no literal
  "bounced" status, so these map the loop's terminal outcomes onto whatever
  statuses actually exist in the *child ticket's* (Bug/Story/Task) workflow.
  **Important**: check the child issue type's own transitions
  (`getTransitionsForJiraIssue`) — epics have a separate, simpler workflow
  and will give you the wrong answer.
- `ceilings.{maxRunsPerDay,maxCostPerRunUsd,runTimeoutMin}` — enforced by
  `src/ceilings.ts`; a breach pauses the loop, it never silently continues.
- `autoPromoteLabel` — a ticket label that lets a passing verdict skip the
  human Review epic and go straight to Ready.
- `targetRepo.{url,defaultBranch}` — the codebase this pipeline operates on
  (not this pipeline repo itself).

## Appendix A (Jira wiring)

Every Jira-specific value above starts as the literal placeholder string
`"___"` in a fresh `pipeline.<project>.config.json`. `findPlaceholders()` /
`assertNoPlaceholders()` in `src/config.ts` detect leftover placeholders —
`RealJiraClient` refuses to make a Jira call while any remain. Filling these
in for a real project means: creating (or identifying) the three pipeline
epics in Jira, checking the *child ticket* workflow for real status names,
and confirming `epicLinkField` against whether the project is team-managed
or company-managed.

## Adding a new project

1. Copy an existing `pipeline.<project>.config.json` to
   `pipeline.<new-project>.config.json`.
2. Fill in that project's own Jira epics, statuses, JQL, and `targetRepo`.
3. Point the loop runner at that file (`loadConfig(path)` — `loadConfig` has
   no default path on purpose, so there's no implicit single-project
   coupling).

No code changes required. The project's **repo slug** — used to namespace
`runs/<slug>.jsonl` and `.pipeline/<slug>/...` so multiple projects can
coexist under one `dev-loop` checkout — is derived from `targetRepo.url` by
`repoSlugFromUrl()` in `src/config.ts` (e.g. `"webtarsthree"` from
`git@github.com:fandango/webtarsthree.git`), not a separate config field.
