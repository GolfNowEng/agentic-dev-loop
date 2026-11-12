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

## [Unreleased — 2.2.0] — planned

Not built yet. Design: [docs/superpowers/specs/2026-11-12-sbx-sandboxed-spawns-design.md](docs/superpowers/specs/2026-11-12-sbx-sandboxed-spawns-design.md).

- `[core]` A failed `claude -p` is detected from its JSON result
  (`is_error` / `terminal_reason`), not just its exit code. In the sbx
  spike, a run with no credential hung for about 3 min, then exited 0 with
  `terminal_reason: api_error`. Today's loop would record that as a
  success.
- `[core]` A claude -p run that exits 0 but reports a failed result (is_error, a terminal_reason other than "completed", or no result at all) is now an agent_error instead of a silent success.
- `[core]` Pluggable sandbox adapter for agent spawns: `--sandbox=<name>`
  or `sandbox.adapter` in project config. The default `none` keeps
  today's behavior exactly. The first adapter is `sbx` (Docker Sandboxes
  with the Keystone kit). Everything sbx-specific lives in
  `src/sandbox/sbx/`, so it can be removed, or another sandbox added,
  without touching the loop.
- `[core]` Optional "sandbox" config block and --sandbox=<name> flag (CLI wins; --sandbox=none forces it off). Only the none adapter exists so far; the default is unchanged.
- `[core]` New outcome `parked` and failure category `sandbox_denied`: a
  sandbox block (network, credential, infra) puts the ticket on hold
  without counting an attempt. `npm run sandbox:approvals` lists parked
  tickets and prints the allow commands for a human to run.
- `[core]` New iteration outcome "parked" (failure_category sandbox_denied): a run the sandbox refused is held without counting an attempt or touching Jira, skipped by the poll, and announced by a desktop notification.
- `[core]` The skill runner gives each sandboxed run its own instance name (`dl-<ticket>-<role>-<6 hex>`, shown in the "running" line) and mounts (repo root plus the target checkout when it is outside it). In enforce mode a sandbox refusal returns `parked` before verdict.json is read; discover mode logs it and carries on. The selected adapter's preflight and orphan cleanup run once at startup, before the session lock.

## [2.1.0] — 2026-11-12

- `[core]` **Breaking for the command line, not for Jira:** every value
  flag is now `--name=value` only, across `npm run loop`, `reset-project`,
  `stats`, `cutover:migrate`, `cutover:relabel` and the eval tools. The
  old space-separated form (`--project webtarsthree`) exits with the exact
  replacement (`use --project=webtarsthree`), so a stale command can't
  silently do something else. Boolean flags (`--once`, `--stream`,
  `--dry-run`, `--yes`, `--write`) stay bare. A flag given twice, or a
  value on a boolean, is also an error. One shared parser,
  `src/core/flags.ts`, replaces five hand-rolled ones.
- `[core]` The version is bumped while the trigger labels stay
  `pipeline:v2.0.0`. Only the CLI changed, not the Jira flow, so worker
  startup shows the minor-mismatch warning (`label is for 2.0.0`) until
  the labels are bumped. No relabel is required.

## [2.0.0] — 2026-11-12

dev-loop and research-loop are now one repo with two phases. Run
`npm run loop -- --project <name>` (worker mode, both roles) or add
`--phase research|dev` for one role. Per-divergence
detail and evidence: [docs/migration-ledger.md](docs/migration-ledger.md).

### Pipeline guards (behavior changes)

- `[hooks]` `[core]` Eval harness (Task 16, spec §9.2): `npm run eval -- <clean|ambiguous|dev-bounce|blocked|queue>` or `--all`. It runs the real loop, `--config pipeline.eval.config.json --once`, against the private sandbox `JustinChan-fd/dev-loop-eval-sandbox`. That config's polls require `labels = "dev-loop-eval"`, and its ceilings are lower: $15 research, $10 dev, 10 runs per role per day. Pure graders (`evals/check-*.mjs`) read the v2 records plus the GitHub/Jira state, and `DRY_RUN=1` prints every outward command instead of running it. New hook `block-non-eval-jira-writes.sh`, registered on every `mcp__atlassian__` tool, is inert unless `DEVLOOP_EVAL_KEYS` is set. While it is set, the hook denies any Jira write to a key outside the list, a link with a foreign end, a `createJiraIssue` without the `[dev-loop-eval]` summary prefix, and any unknown atlassian write; it also fails closed on malformed input. A `createJiraIssue` needs all five conditions: project TARS, the `[dev-loop-eval]` prefix, the `dev-loop-eval` label, no parent (or a listed one), and no transition. Dry is the default: only exactly `DRY_RUN=0` runs live, and any other value (e.g. `true`) is refused. So far the harness is verified only with stubs. The sandbox repo, the live preflight and the first paid run each need the user's go (see `evals/README.md`).

- `[core]` The eval harness's `run_to` (`evals/lib.sh`) now stops the whole process tree on timeout (session final review I2). Before, perl's `alarm` sent SIGALRM to `npm` only; npm forwards only SIGINT/SIGTERM, so `node src/main.ts` and its paid `claude -p` child kept running past the 3.5 h cap and the next scenario's loop hit `LiveWorkerError`. The command now runs in its own process group; on timeout the group gets SIGTERM, then SIGKILL after `RUN_TO_GRACE_S` (default 40 s), and `run_to` exits 124. `evals/run.sh` also refuses live mode (`DRY_RUN=0`) when `CLAUDECODE` is set, so an agent inside a Claude Code session cannot start a paid eval (the unsafe-git checker cannot see into `bash evals/run.sh`); dry mode still works there.
- `[core]` The env file can live outside the repo (final-review I4). `loop`, `check-auth`, `cutover:relabel` and `reset-project:remote` now load `--env-file="${DEVLOOP_ENV_FILE:-.env}"`: unset, they read the root `.env` as before; set (recommended `DEVLOOP_ENV_FILE=$HOME/.config/dev-loop/.env`), the Jira token is no longer inside the `claude -p` spawn cwd, where a Bash `cat .env` could read it. Startup warns when the variable is set but a `.env` is still in the repo root (`src/core/env-file.ts`), unless the variable resolves to that root `.env` itself (compared as resolved paths); the missing-credential hints name the variable. The user moves the file; nothing moves it for them. See docs/config.md "Env file location".
- `[hooks]` `block-unsafe-git` closes three documented residuals. An unknown wrapper whose single quoted argument hides a git push/commit or gh stack (`watch '...'`, `ssh host '...'`, `npx sh -c '...'`, `tmux new '...'`) is unverifiable. `printf -v`, `read` and `mapfile`/`readarray` naming `HUSKY`/`HUSKY_SKIP_HOOKS` are denied, and naming `GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_KEY_<n>` is unverifiable. A shell reading its script from stdin is analyzed by content for a here-string, a heredoc or a pipe from a literal `echo`/`printf` (`echo '...' | sh`, `bash <<< '...'`); any other stdin (`bash < f`, `cat f | sh`, `curl ... | bash`) is unverifiable. A shell script operand of `/dev/stdin`, `/dev/fd/0` or `/proc/self/fd/0` reads stdin, so it gets the same stdin rules as `-`. A nameref (`declare`/`typeset`/`local -n r=NAME`) is checked by its target with the same HUSKY/GIT_CONFIG rules, and a nameref with no target yet is unverifiable; `getopts OPTS NAME` and zsh's `vared NAME` join `printf -v`/`read`/`mapfile`. git's own exec hooks (`rebase --exec`, `submodule foreach`, `bisect run`) and interpreter one-liners remain documented residuals.
- `[core]` A signal no longer lets the worker spawn a child or count an error attempt while it stops (final re-review minor 2). Before, the cycle kept running during the SIGINT/SIGTERM handler's awaits: a phase reached between kill and exit could spawn `claude -p` (orphaned, able to push) or write an in-flight into a just-released lock, and a killed child's run was appended as an `error` record, counted against `maxAttemptsPerTicket`. Now `stopOnSignal` calls `TrackedSession.beginStop()` first, synchronously: the cycle's `setInFlight` (set or clear) never calls through and never settles, so the cycle makes no further lock writes and spawns no new child, and `canRelease()` is false. Writes outside `setInFlight` can still happen in the stop window (polls, `claimTicket`, the missing-fields comment plus its `claim-error` record, `resume-dropped` and other record appends); all are idempotent or deduped, and closing that window is parked. `killActiveChild` (and the new `stopSpawning`) set a module-level flag first, so any later spawn settles with `spawnError: "stopping: signal received"` without spawning. A killed run's flight stays marked interrupted; the next start records it `interrupted`, not an attempt. A lock write already in flight when the signal arrives is awaited first, so the handler marks a landed set interrupted and releases after a landed clear, and that write's caller freezes once it lands. A pause reached while stopping no longer exits 1 over the signal's 130/143.
- `[core]` A resume re-reads the ticket's Jira status first (final-review M5). Before, a crashed or interrupted phase run was resumed (a paid run) even if a human had since moved the ticket. `JiraClient.getStatus` is new. Both `resumeNext` and the first-iteration flight recording (`recordFlights`, before a crashed dev flight's open-PR self-heal) check it: they proceed only when the live status equals `claimStatus.to`, else append a `resume-dropped` record (no phases, not an attempt, resolves the pending resume). A dev resume also accepts `statusNames.prOpen` (Code Review, Ruling 51; found in the session final review: a signal or crash after `runDevPhase` had moved the ticket left the landed run `resume-dropped`, with no landed record for reconcile, so a later Development Complete status could start a paid dev run on a merged ticket): with an open PR it records the same `skipped-pr-exists` landed entry without a Jira transition; with no open PR (merged, closed, or lookup failed) it is `resume-dropped` ("Code Review with no open PR") and dev is never re-run. Known gap: a merged PR at that point gets no landed record yet (parked). A failed status lookup leaves the resume pending, excludes the ticket from this iteration's polls, and retries next iteration.
- `[core]` Claiming a ticket now names the field(s) Jira requires for the transition (seen on TARS-1631: `Field Story Points is required.`). The claim POST's 400 is parsed (`parseRequiredFields`) into a `ClaimMissingFieldsError`; the `claim-error` record reads `claim blocked: required field(s) missing: Story Points` and the ticket gets one Jira comment (not repeated while the field set is unchanged). Other claim failures behave as before.
- `[hooks]` `[core]` Final-review hardening. `block-unsafe-git` now sees through `direnv exec <dir>` (Ruling 31's mandated spelling had bypassed it entirely: `direnv exec <wt> git push --force` was allowed) and `find -exec/-execdir`; it denies any assignment or `export` of `HUSKY`/`HUSKY_SKIP_HOOKS` and any `GIT_CONFIG_*` naming `hookspath`; and an unknown command (`npx`, `npm exec`, `pnpm exec`, `yarn`, ...) whose separate argument words include `git` then `push|commit`, or `gh` then `stack`, is unverifiable and denied (a guarded call inside one quoted script argument, e.g. `npx sh -c '...'`, is a documented residual). Interpreter one-liners and deleting/`chmod`ing hook files remain documented residuals in the checker header. The secret scan now also covers `gh pr comment`, `gh pr review --body/-b` and `gh api -f/-F body=`. `.claude/settings.json` denies `Read(/.env*)` next to `Edit(/.env*)`. A SIGINT/SIGTERM to the worker now stops the running `claude -p` child (SIGTERM, SIGKILL after `KILL_GRACE_MS`) before marking the flight interrupted; before, a `kill <pid>` left it running orphaned, able to push beside the resumed run. Startup refuses a `targetRepo.path` that is the dev-loop root, an ancestor of it, or inside it (other than the v2 clone dir). `scripts/migrate-v1-folders.mjs --v2-from <worktree>` carries the worktree's `runs/v2` and `.pipeline/v2` into the main checkout (Ruling 40); `docs/cutover.md` is reordered (Ruling 39). `scripts/size-checkpoint.mjs` is deleted.
- `[dev]` Cutover tooling: `scripts/migrate-v1-folders.mjs` (moves both repos' v1 `runs/` and `.pipeline/` under `runs/v1/{dev,research}/` and `.pipeline/v1/{dev,research}/<slug>/`; dry run by default, refuses on an existing destination or a running loop) and `scripts/relabel-v1-refined.mjs` (adds the dev trigger label to tickets whose latest research comment is a `✅` by `JIRA_ASSIGNEE_ACCOUNT_ID`; `--write` needs `--confirm <sha256>`). Run order and approval points: [docs/cutover.md](docs/cutover.md). `npm run cutover:migrate` / `cutover:relabel`.
- `[core]` Worker mode is the default (`--phase worker|research|dev`, `src/core/cli-args.ts`): one session runs both roles via `runWorkerIteration`. Startup: config -> placeholder check -> label-version guard (worker only: an unversioned or other-major trigger label exits 1, so `catalog-ui-*` are refused until cutover; a minor/patch difference warns) -> credentials -> session (a second start names the live session and exits 1) -> adopted flights recorded -> loop. Unknown arguments and flags without a value are errors; no session test seam is reachable from the CLI.
- `[core]` Skills get their paths: the prompt is `/<skill> <KEY> run-dir=<abs RUN_DIR> repo-dir=<abs REPO_DIR>` (`src/core/build-prompt.ts`, validated; `src/worker/skill-runner.ts`). The runner creates RUN_DIR and reads only `RUN_DIR/verdict.json`; the v1 snapshot/newest-run-dir discovery (`run-dirs.ts`) and `legacyRunDirs` are deleted. `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` = the role's `runTimeoutMin` x 60000. Contract strings live in `src/core/contract.ts`, pinned in both skills by `contract.test.ts`; `test/structure.test.ts` checks `.claude/**` paths exist, hook commands are executable, no skill/agent names `.pipeline/`, and banned git flags appear only beside "never"/"banned".
- `[research]` The research spawn runs from the repo root, not `research-loop/` (deleted, with its `.claude` symlink). It excludes the root `CLAUDE.md` and gets its skeptic stance from `src/roles/research/stance.md` via `--append-system-prompt`.
- `[research]` The research spawn is denied Edit/Write/NotebookEdit under REPO_DIR (`permissions.deny` `Edit(//<REPO_DIR>/**)` etc. in its `--settings`). `--allowedTools` only auto-approves, so acceptEdits plus `--add-dir` had made the target checkout writable (a live control probe edited it). RUN_DIR stays writable. Bash is still broad, so research is only partly read-only.
- `[core]` Prompt paths are checked against an allowlist (`^[A-Za-z0-9@._/+-]+$`), not just for whitespace, because the skills paste them into Bash. REPO_DIR is checked at startup, so a malformed `targetRepo.path` exits 1 instead of failing every ticket.
- `[dev]` Target-repo commands run through `direnv exec <worktree>` (Ruling 31): `ticket-to-pr` (install, tests, lint, build, dev server, `git commit`/`git push` so hooks share the env, baseline and follow-up worktrees) and `qa-agent`. direnv's shell hook never fires headless, so the first two TARS-1625 runs ran webtarsthree's suite without its git-ignored `.envrc` and misread `placements-body-limit.integration.test.js` (needs `PLACEMENT_SERVICE_ENDPOINT`) as broken on master; run 3 found it via the baseline suite and recovered by hand. A blocked or missing direnv bounces `env_setup`; the skill never runs `direnv allow`.
- `[dev]` Commit hooks that run the full suite no longer stall a run (Ruling 30). Found on the second TARS-1625 run: webtarsthree's `.husky/pre-commit` runs `npm test`, so the TDD Red commit (failing tests by design) and every commit while master has a broken test were rejected. Red now commits the new tests marked expected-to-fail (`it.fails`/`test.failing`) and Green removes the marker. Phase 0 records a `baseline_failures` suite run. When pre-existing failures block a hook, `ticket-to-pr` files a linked follow-up Jira ticket (no pipeline label), fixes them test-only on `<FOLLOW_UP>-fix-preexisting-tests` off `origin/<defaultBranch>` with its own PR, then carries that committed fix into the ticket's worktree unstaged so the hooks pass, staging only the ticket's files and checking the fix never enters its commits; it is reverted after the push. A failure needing app code files the ticket only, links it "is blocked by" and bounces. `verdict.json`/iteration records gain optional `follow_up`. The dev spawn's `--allowedTools` adds `mcp__atlassian__createJiraIssue` and `createIssueLink` (still behind the secret-content hooks). Never `--no-verify`/`HUSKY=0`.
- `[dev]` Failures that already exist on master no longer block a PR (Ruling 29). When the full suite fails, `ticket-to-pr` re-runs the failing test files on a throwaway detached worktree of unmodified `origin/<defaultBranch>`. If every branch failure also fails there with the same assertion, it opens the PR anyway, names them in a `## Pre-existing failures` section, a last `qa_notes` entry and `verdict.json`'s optional `preexisting_failures` (carried into the iteration record). A failure only on the branch is still a Green-phase defect; never `--no-verify`. Found on the first real v2 run (TARS-1625): `placements-body-limit.integration.test.js` fails on master because `PLACEMENT_SERVICE` is unset, so the run bounced `tests_flaky` with finished, tested commits.
- `[research]` `[dev]` `ticket-refine`, `ticket-to-pr`, `recon-agent`, `verifier-agent` and `qa-agent` use the given `run-dir=`/`repo-dir=` (missing or malformed: no files, `agent_error`), clone `REPO_DIR` if missing, and create their worktree at `<REPO_DIR>/.claude/worktrees/<KEY>-<RUN_ID>[-ground]`. `ticket-to-pr` Phase 5 says to push with the literal branch name; the passing-verdict Jira template no longer mentions Needs-decision bullets; `auto-promote` mentions are gone.
- `[hooks]` `block-unsafe-git` denies a push argument only known at run time with "spell the branch name literally, or use HEAD". Hook tests now also run from a cwd outside the repo (as after a skill `cd`s into its worktree) instead of via `research-loop/.claude`.
- `[core]` Dead code removed: `planRemoteClose`, `RemoteCloseDeps.runsLogPath`, `runs-log.ts`'s `findOpenPrUrl` (reset's PR lookup is `findRecordedPrUrlAcross`).
- `[core]` The worker cycle (`src/worker/`, `runWorkerIteration`): it claims, runs research, hands the label off and runs dev on the same ticket with no human gate, writing one v2 record per ticket iteration (`runs/v2/<project>.jsonl`). Covered: crash recovery from the session's in-flight record (an open PR self-heals to Code Review, no rebuild), pending-handoff retry, `maxAttemptsPerTicket` (moved to Blocked with a comment, `blocked-attempts`), exclusions that persist across restarts (`recentlyEnded`), a blocker skip logged once per blocker set, 20 skips max per iteration, per-role runs/day, and a post-phase ceiling check before the handoff. A per-ticket failure never pauses or throws; a Jira 401/403 on the poll pauses. See `docs/logging.md` "The worker cycle".
- `[core]` Per-ticket budget (`ceilings.maxCostPerTicketUsd`): research spawns get `min(research cap, ticket cap)`, and dev in the same iteration gets `min(dev cap, ticket cap − research cost)`. Dev is deferred, with the handoff done, when less than $1 remains.
- `[core]` `--phase research|dev` now run the worker cycle restricted to one role, acquire a session (`--session <name>`), and write v2 records. The v1 runner entry points (`runLoopIteration` in both roles), `countRunsToday` and `legacyRunsLog`-based run counting are gone. Research no longer swaps the label itself, and the `auto-promote` label has no effect: every green research hands off, done by the cycle.
- `[dev]` Jira bounce comments and GitHub detail comments built by `src/` end with `— <session>`.
- `[core]` Worker recovery is role-scoped and durable. Adopted in-flight runs (including orphans) are written to the v2 log with `resume: <role>` on the first iteration, and only a process that runs that role resumes them, so a `--phase dev` start never runs ticket-refine. SIGINT/SIGTERM mid-phase marks the lock's flight `interrupted` (not a failed attempt). A lost session lock never drops a finished phase or strands a claimed ticket. A successful step-1 handoff is recorded (`handoff-done`). A polled ticket with an invalid key is excluded by issue id instead of stalling the queue (`JiraTicket.id`, `excludeIdsFromJql`). Dev assigns an unassigned ticket again, as in v1.
- `[core]` A research phase ending `error`/`killed` after a claim is retried (`resume: "research"`) instead of being stranded In Progress, until `maxAttemptsPerTicket` moves it to Blocked. The attempt cap acts only for roles the process runs, resumes respect `maxRunsPerDay`, and a signal before the adopted in-flight runs are in the log keeps the session lock (`recordAdoptedFlights` runs first).

- `[dev]` Merge reconciliation reads both log generations (`findLandedTicketsAcross`: `runs/v2/<project>.jsonl`, and the v1 dev log, v2 winning per ticket). On a merge it removes every pipeline label (research trigger, handoff, dev trigger, `pipeline:research`, `pipeline:dev`), each independently, and the mirror-Issue close comment ends with `— <session>`.
- `[core]` v1 readers (reconcile, the dev landed guard, research's "already refined in v1" check, `stats --v1`, reset's PR lookup) read `runs/v1/<role>/<project>.jsonl` when it exists, else the pre-cutover live log (`runs/<project>.jsonl` for dev, `research-loop/runs/<project>.jsonl` for research): `resolveV1RunsLog`.
- `[core]` `npm run stats` reports v2 by default, per role from phase entries (runs, landed, bounced, error/killed, cost); `--v1` reports v1 dev and research separately and names the file read; `--root <dir>`. It never writes.
- `[core]` Reset works on v2 state with `--role research|dev|all` (default all): `<role>-*` run dirs in every session, and records with a phase (or resume) of that role, archived to `runs/v2/<project>.reset-archive.jsonl`. A whole-project role-all reset also prunes session leftovers (`.lock.adopted-*`, `.acquire.stale-/reclaim-/release-*`, `.tmp-*`), never a lock or the mutex. No v1 location is ever modified, in either layout; `executeReset` refuses paths outside the project's v2 roots. A role-scoped reset refuses (keeps, and lists as `REFUSED`) a record whose other role landed, unless `--include-cross-role`, so `--role research` can never drop a landed dev PR. A real reset refuses while a live worker holds a session lock (`--ignore-live-worker` overrides). The scan never follows symlinks (skipped with a WARNING). The cwd no longer selects the role (`--root` overrides the state root). The deprecated `legacyRunsLog`/`legacyRunsArchive`/`legacyPipelineDir`/`legacyRawUsageDir` path functions are gone (`legacyRunDirs` followed in Task 15).

- `[core]` `src/core/blocker-gate.ts`: the blocker gate. A ticket's Jira "is blocked by" links (`JiraClient.getBlockedBy`, keys validated) must all be cleared, meaning the blocker's PR merged into the default branch of the project's own repo (the recorded PR, only if its URL is in that repo, merged with `baseRefName` equal to the default branch; or a whole-token `gh` search filtered on `baseRefName`). The gate fails closed: an open PR, another base, a cross-project blocker or any error means not cleared, with a redacted reason capped at 200 chars. A human clears a no-PR or cross-repo blocker by removing the link. `ExecGhPrViewFn`/`ExecGhFindMergedPrFn` and their real implementations moved from `roles/dev/reconcile.ts` into `core/github-client.ts`, and `realDefaultBranch(repo)` was added there.
- `[core]` `src/core/iteration-log.ts`: the v2 per-ticket-iteration record (`runs/v2/<project>.jsonl`, append-only, one `appendFile` per line). `detail`/`jira_sync_error` are redacted at record and phase level; ticket and session are validated before writing. Readers skip blank, truncated-final, malformed and bad-ticket lines (`readIterationsDetailed` also returns the skip count). `findLandedPrUrlAcross`/`findLandedTicketsAcross` look up landed dev PRs across the v1 and v2 logs, v2 winning per ticket.
- `[core]` `src/core/session.ts`: one live worker per project via `<sessions>/<name>.lock` (`LiveWorkerError` names the holder). Acquire runs under a project-wide `.acquire` mutex (a nonce in every body; a stale one is reclaimed under a per-body claim and never restored, so it can't be hit by ABA), and every lock is published atomically (temp file + link), so a half-written lock is never seen. Process start times are epoch seconds from `ps -o lstart=` under `LC_ALL=C TZ=UTC`, and a pid whose start time can't be read counts as alive. A second acquire by the same process refuses. A dead or reused-pid lock is reclaimed and its `inFlight` adopted for resume; extra records come back as `orphanedInFlight` and are never dropped. Corrupt locks are reclaimed with `inFlight: null` and never throw.
- `[core]` `src/core/paths.ts` is the single owner of on-disk paths: validated identifiers, containment checks (`UnsafePathError`), v2 layout (`runs/v2/`, `.pipeline/v2/`). The `--phase` runners and reset use its `legacy*` functions until Task 13/14.
- `[core]` Every `claude -p` spawn gets `--max-budget-usd` (from
  `ceilings.maxCostPerRunUsd`), and a run past `runTimeoutMin` is killed with
  SIGTERM, then SIGKILL after a grace period, instead of being left running.
- `[core]` The child process env strips `JIRA_API_TOKEN`, `JIRA_EMAIL` and
  `JIRA_BASE_URL` (`childEnv`), so agents cannot read Jira credentials from it.
  `JIRA_ASSIGNEE_ACCOUNT_ID` passes through: it is an account id, not a secret.
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
