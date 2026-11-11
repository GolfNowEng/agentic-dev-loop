# Changelog

Notable fixes and behavior changes to the pipeline itself (not the tickets it
processes). Newest first. Add an entry whenever you fix a bug a human had to
diagnose from a real run.

Tag every bullet with where it applies: `[core]` (src/core, both phases),
`[research]` (research phase only), `[dev]` (dev phase only), `[hooks]`
(`.claude/hooks`, `.claude/settings.json`).

History before 2.0.0 lives in two files, one per former repo:

- [docs/changelog/dev-loop-legacy.md](docs/changelog/dev-loop-legacy.md)
- [docs/changelog/research-loop-legacy.md](docs/changelog/research-loop-legacy.md)

## [2.0.0] — unreleased

dev-loop and research-loop are now one repo with two phases. Run
`npm run loop -- --phase research|dev ...`; the flag is required. Per-divergence
detail and evidence: [docs/migration-ledger.md](docs/migration-ledger.md).

### Pipeline guards (behavior changes)

- `[core]` Every `claude -p` spawn gets `--max-budget-usd` (from
  `ceilings.maxCostPerRunUsd`), and a run past `runTimeoutMin` is killed with
  SIGTERM, then SIGKILL after a grace period, instead of being left running.
- `[core]` The child process env strips every `JIRA_*` variable (`childEnv`), so
  agents cannot read Jira credentials.
- `[hooks]` New `block-unsafe-git` PreToolUse hook blocks unsafe git operations
  from agent spawns.
- `[hooks]` `permissions.deny` rules protect the pipeline's own files
  (settings, hooks, skills, agents) from agent edits.
- `[research]` Research spawns exclude the repo-root `CLAUDE.md`
  (`claudeMdExcludes`), so the skeptic stance in `research-loop/CLAUDE.md` is
  not overridden by the dev phase's "trust the ticket" stance.
- `[core]` An errored or timeout-killed run now logs its real cost and tokens
  to `runs/<project>.jsonl` and feeds them to the post-run ceiling; v1 logged 0,
  so budget-capped runs bypassed `maxCostPerRunUsd` and undercounted stats.
- `[dev]` `alwaysThinkingEnabled` (project settings) now applies to dev runs too;
  previously only research-loop's settings carried it.
- `[core]` `--phase research|dev` is required; there is no default phase.
- `[core]` One `pipeline.<project>.config.json` per project, shared by both
  phases (`roles.research` / `roles.dev`, docs/config.md). The loader validates
  it and rejects unknown keys, `autoPromoteLabel`, and label/status values with
  `"`, `\` or a newline. Startup refuses the `"___"` values the chosen phase
  needs. research-loop's own config copies are gone; both v1 sets are archived
  under `docs/changelog/legacy-config/`. New `ceilings.maxAttemptsPerTicket`
  (2) and `ceilings.maxCostPerTicketUsd` (50), unused until the worker.
- `[core]` Poll JQL is built by `buildPollJql`, which throws on an unfilled
  placeholder or a malformed assignee account id. `excludeKeysFromJql` throws on
  anything that is not a Jira ticket key, instead of interpolating it.
- `[research]` webtarsthree's research poll is now `pipeline:v2.0.0`, and its
  green-verdict handoff label is `pipeline:v2.0.0:dev` (was `pipeline:research`
  → `pipeline:dev`). `--phase research` still swaps labels only for
  `auto-promote` tickets, the v1 rule, now a constant in the runner.
- `[dev]` webtarsthree's dev poll is now `pipeline:v2.0.0:dev`, without the
  assignee clause. Both webtarsthree polls exclude `dev-loop-eval` tickets.
  Merge reconciliation removes the dev trigger label.

### Fixes now shared by both phases (ledger class a)

- `[core]` `claim-error` poll result: a throwing claim sleeps `pollIntervalSec`
  rather than crashing the loop (was research-only; inert for dev until it has a claim).
- `[core]` `hasLandedRun(path, key)` in runs-log (was research-only).
- `[core]` Redaction: values starting with `[` in unquoted env/JSON assignments
  are now redacted (dev leaked them).
- `[core]` Redaction: pass order now also catches an env-style assignment in
  JSON-value position past a comma (research left the remainder).
- `[core]` Redaction: a quoted all-digit secret, e.g. `{"password":"123456789012"}`,
  is redacted; the true/false/number skip applies to unquoted values only.
- `[core]` Verdict parsing accepts and sanitizes `size_trajectory` under both
  profiles; a malformed one is dropped and never flips the outcome to error.
- `[core]` `CURRENT_LOG_VERSION` and the optional `log_version` / `size_trajectory`
  fields on `RunLogLine` (research-only before; dev lines stay implicit "1.0").
- `[core]` `GitHubIssue.state` is returned by both `findIssueByJiraKey` and
  `createIssue`; `createIssue` is available on the shared client.
- `[core]` `JiraTicket.labels` is returned by both poll calls.
- `[core]` `transitionStatus(key, to, fields?)` signature shared; omitting `fields`
  sends research's old body.

### Refactors (ledger entries that are dedup/rename/wording, not fixes)

- `[core]` One `excludeKeysFromJql` (`key not in (...)`) replaces dev's private
  `key != ...` chain; equivalent JQL.
- `[core]` `checkCeilings` takes explicit limits and returns research's
  `{breached, reason, detail}`; `detail` lists every breach. `assertWithinCeilings`
  carried over, no production caller.
- `[core]` `parseVerdict(raw, profile)` with `"refine"` / `"executor"` profiles;
  `config` role parameter for `assertNoPlaceholders` (`jira.codeReviewFields`
  now optional in `Config`, required for the dev role at startup).
- `[core]` `findOpenPrUrl` moved from the dev reconcile module to core runs-log,
  so core imports no role code. reset-cli and remote-close use the dev (PR-closing)
  superset for both phases; research data has `pr: null`, so nothing changes there.
- `[core]` Role-neutral wording in reset-project and github-client headers;
  renamed/aliased verdict helpers.
