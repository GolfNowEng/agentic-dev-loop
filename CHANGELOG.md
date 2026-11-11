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

- `[core]` The worker cycle (`src/worker/`, `runWorkerIteration`): it claims, runs research, hands the label off and runs dev on the same ticket with no human gate, writing one v2 record per ticket iteration (`runs/v2/<project>.jsonl`). Covered: crash recovery from the session's in-flight record (an open PR self-heals to Code Review, no rebuild), pending-handoff retry, `maxAttemptsPerTicket` (moved to Blocked with a comment, `blocked-attempts`), exclusions that persist across restarts (`recentlyEnded`), a blocker skip logged once per blocker set, 20 skips max per iteration, per-role runs/day, and a post-phase ceiling check before the handoff. A per-ticket failure never pauses or throws; a Jira 401/403 on the poll pauses. See `docs/logging.md` "The worker cycle".
- `[core]` Per-ticket budget (`ceilings.maxCostPerTicketUsd`): research spawns get `min(research cap, ticket cap)`, and dev in the same iteration gets `min(dev cap, ticket cap − research cost)`. Dev is deferred, with the handoff done, when less than $1 remains.
- `[core]` `--phase research|dev` now run the worker cycle restricted to one role, acquire a session (`--session <name>`), and write v2 records. The v1 runner entry points (`runLoopIteration` in both roles), `countRunsToday` and `legacyRunsLog`-based run counting are gone. Research no longer swaps the label itself, and the `auto-promote` label has no effect: every green research hands off, done by the cycle.
- `[dev]` Jira bounce comments and GitHub detail comments built by `src/` end with `— <session>`.
- `[core]` Worker recovery is role-scoped and durable. Adopted in-flight runs (including orphans) are written to the v2 log with `resume: <role>` on the first iteration, and only a process that runs that role resumes them, so a `--phase dev` start never runs ticket-refine. SIGINT/SIGTERM mid-phase marks the lock's flight `interrupted` (not a failed attempt). A lost session lock never drops a finished phase or strands a claimed ticket. A successful step-1 handoff is recorded (`handoff-done`). A polled ticket with an invalid key is excluded by issue id instead of stalling the queue (`JiraTicket.id`, `excludeIdsFromJql`). Dev assigns an unassigned ticket again, as in v1.
- `[core]` A research phase ending `error`/`killed` after a claim is retried (`resume: "research"`) instead of being stranded In Progress, until `maxAttemptsPerTicket` moves it to Blocked. The attempt cap acts only for roles the process runs, resumes respect `maxRunsPerDay`, and a signal before the adopted in-flight runs are in the log keeps the session lock (`recordAdoptedFlights` runs first).

- `[core]` `src/core/blocker-gate.ts`: the blocker gate. A ticket's Jira "is blocked by" links (`JiraClient.getBlockedBy`, keys validated) must all be cleared, meaning the blocker's PR merged into the default branch of the project's own repo (the recorded PR, only if its URL is in that repo, merged with `baseRefName` equal to the default branch; or a whole-token `gh` search filtered on `baseRefName`). The gate fails closed: an open PR, another base, a cross-project blocker or any error means not cleared, with a redacted reason capped at 200 chars. A human clears a no-PR or cross-repo blocker by removing the link. `ExecGhPrViewFn`/`ExecGhFindMergedPrFn` and their real implementations moved from `roles/dev/reconcile.ts` into `core/github-client.ts`, and `realDefaultBranch(repo)` was added there.
- `[core]` `src/core/iteration-log.ts`: the v2 per-ticket-iteration record (`runs/v2/<project>.jsonl`, append-only, one `appendFile` per line). `detail`/`jira_sync_error` are redacted at record and phase level; ticket and session are validated before writing. Readers skip blank, truncated-final, malformed and bad-ticket lines (`readIterationsDetailed` also returns the skip count). `findLandedPrUrlAcross`/`findLandedTicketsAcross` look up landed dev PRs across the v1 and v2 logs, v2 winning per ticket.
- `[core]` `src/core/session.ts`: one live worker per project via `<sessions>/<name>.lock` (`LiveWorkerError` names the holder). Acquire runs under a project-wide `.acquire` mutex (a nonce in every body; a stale one is reclaimed under a per-body claim and never restored, so it can't be hit by ABA), and every lock is published atomically (temp file + link), so a half-written lock is never seen. Process start times are epoch seconds from `ps -o lstart=` under `LC_ALL=C TZ=UTC`, and a pid whose start time can't be read counts as alive. A second acquire by the same process refuses. A dead or reused-pid lock is reclaimed and its `inFlight` adopted for resume; extra records come back as `orphanedInFlight` and are never dropped. Corrupt locks are reclaimed with `inFlight: null` and never throw.
- `[core]` `src/core/paths.ts` is the single owner of on-disk paths: validated identifiers, containment checks (`UnsafePathError`), v2 layout (`runs/v2/`, `.pipeline/v2/`). The `--phase` runners and reset use its `legacy*` functions until Task 13/14.
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
- `[research]` ticket-refine no longer reads the removed `autoPromoteLabel` key.
  Its `✅ research-loop -` comment output is unchanged from v1 (section always
  omitted): the "Needs decision" section is never written.
- `[core]` `reset-project` run from `research-loop/` (the research phase's
  state root) reads the project config from the repo root, since
  `research-loop/` no longer has its own copy.

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
