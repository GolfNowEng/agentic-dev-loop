# dev-loop 2.0.0 — the worker monolith

Status: draft for approval. Date: 2026-11-10. Owner: Justin (manager);
builder: Claude, working TDD from approved plan onward.

## 1. Intent

Today there are two single-ticket loops in two repos: `research-loop`
(Terminal A, the skeptic: refines a Jira ticket) and `dev-loop` (Terminal B,
the executor: turns a refined ticket into a PR). A human approves between
them unless the ticket carries `auto-promote`.

2.0.0 merges both into this repo and reframes the product as a **worker**:
something the manager spawns like hiring a developer. A worker has its own
name, picks up a ticket, researches it, and — if research is green — builds
it and lands a PR, with no human gate in between. The long-term goal is N
workers on the same repo and the same ticket set, coordinated so dependent
work is sequenced and independent work runs in parallel, preferably landing
as GitHub stacked PRs.

**2.0.0 ships the one-worker case.** One worker per repo, one ticket at a
time, research → dev end to end, on real tickets. Everything the multi-worker
future needs is either built in now (because retrofitting it later is a
rewrite) or explicitly deferred (because it is a feature that can be added).

## 2. Goals, non-goals, anti-goals

### Goals (2.0.0)

- G1. One repo (`dev-loop`) houses both roles' code, skills, agents, hooks,
  tests, configs, docs and changelog history.
- G2. A single worker process picks a ticket, runs the research phase (the
  existing `ticket-refine` skill and its three agents), and on a green
  verdict runs the dev phase (the existing `ticket-to-pr` skill and
  `qa-agent`) on the same ticket in the same run. No human approval gate.
- G3. Every worker has a name/session id (`dev-1`, …) recorded on every log
  record, run directory and outward-facing artifact it owns.
- G4. Blocker gate: a ticket with an unresolved Jira "is blocked by" link is
  not started.
- G5. All existing safety behavior survives: bounce-with-evidence in either
  phase, ceilings (runs/day, cost/run, timeout), secret-redaction hooks,
  reconcile, reset-project, worktree isolation from the human's checkout.
- G6. Version is `dev-loop:2.0.0` (package.json `version`, recorded in every
  run log record as `loop_version`); later releases bump semver (patch for
  fixes, minor for new capability such as the blocker rule changing or stack
  mode, major for breaking changes to the ticket/label/comment contract).
  The Jira trigger label is `pipeline:v2.0.0` (manager's choice). It is read
  from config, not derived from `package.json`, so a version bump never
  silently orphans tickets already labelled. Builder's call: startup logs a
  warning when the label's version and `package.json`'s differ, and a
  release that changes the label ships a dry-run-first relabel script for
  tickets still in the queue.

### Non-goals (2.0.0; designed for, not built)

- More than one worker per repo at once (needs the claim step — §7).
- Batch orchestrator and stacked PRs (§8).
- Epic-branch mode.
- Moving pipeline state from Jira to GitHub Projects (existing
  `docs/future-enhancements.md` entry; untouched by this work).

### Anti-goals (failure even if it "works")

- A1. Breaking the cross-phase contract strings the dev phase depends on
  (`✅ research-loop -` / `❌ research-loop -` comment titles, the label
  names on tickets already in flight). Existing refined tickets must still
  be pickable by the dev phase.
- A2. Two roles' state colliding on disk (today both repos write
  `runs/<project>.jsonl` and `.pipeline/<project>/<ticket>/`).
- A3. Sessions coordinating through chat/messages as the source of truth.
  Jira and GitHub are the record; a restarted worker must be able to see
  where things stand from them alone.
- A4. Any force push, `--force-with-lease`, or `gh stack push/sync/submit`,
  now or in the later stack mode.
- A5. The research skills and dev skills reaching into each other. They stay
  separate units with one written handoff between them.
- A6. Disrupting the live v1 loops during migration.

## 3. Constraints

- The live `research-loop` and `dev-loop` (v1) keep processing real tickets,
  untouched, until 2.0.0 has completed one real ticket end to end. 2.0.0 is
  built on a branch in a worktree of this repo. Until cutover, 2.0.0 runs
  against `repo:webtarsthree` (manager's choice) using its **own trigger
  label**, `pipeline:v2.0.0` (builder's call), so v1 loops (which poll
  `pipeline:research` / `pipeline:dev`) never match a v2 ticket and v2
  never matches theirs. Test tickets are created by hand or by the eval
  harness with `repo:webtarsthree` + `pipeline:v2.0.0`. Config:
  `pipeline.webtarsthree.config.json` gains a v2 section; v1's keys are
  untouched until cutover. (`pipeline.loop.config.json` stays the
  poll-interval file.)
- `npm test` green before and after every change to `src/` (existing rule).
  TDD: failing test committed before implementation (existing rule).
- Node ≥ 22.18, vitest, TypeScript as today. No new runtime dependencies
  without a stated reason.
- Users' stacked-PR rules (for later stack mode, recorded here so nothing in
  2.0.0 contradicts them): plain `git push -u`; `gh pr create --base
  <parent-branch>`; push-branch Jira transitions; `gh stack link <PR#…>` by
  PR number; when a parent merges, retarget the child with `gh pr edit
  --base`, never rebase + force-push.

## 4. What the manager decided (as decided)

- This repo becomes the monolith; research-loop is brought in.
- Treat it as a major version: `dev-loop:2.0.0`, semver after.
- One worker does research then dev on the same ticket; green → go, no
  human gate (the `auto-promote` label stops mattering for this; see §6.3).
- Same blockers/bounce behavior as today, plus the blocker gate.
- Skills stay focused per role (research skills vs dev skills) to keep
  responsibilities divided.
- First milestone: one instance per repo, grabbing real tickets.
- Future: parallel tickets, background sequencing, and batches landing as
  `gh` stacked PRs (preferred landing shape), coordinated by a
  batch-orchestrator skill/agent inside one dev-loop process — not by
  separate dev-loop sessions messaging each other.

## 5. Repo layout (target)

```
src/
  core/        jira-client, github-client, config, redact, runs-log,
               run-dirs, ceilings, claude-usage, poll-loop, jql,
               reset-project, reset-cli, remote-close, verdict (shared parts)
  roles/
    research/  research phase runner, research verdict handling
    dev/       dev phase runner, reconcile, qa-browser, code-review fields
  worker/      the worker: poll → gate → claim → research → dev → log
  main.ts      CLI entry
.claude/
  skills/
    ticket-refine/   (from research-loop, unchanged except paths)
    ticket-to-pr/    (unchanged except paths)
    reset-project/   (one skill, gains --role)
  agents/      recon-agent, devils-advocate-agent, verifier-agent, qa-agent
  hooks/       union of both repos' hooks (see §6.6)
pipeline.<project>.config.json   one per project, both roles (§6.4)
docs/          merged docs; docs/changelog/*-legacy.md
evals/         skill-level evals (§9.2)
test/          unit tests mirroring src/
```

Exact module boundaries inside `src/` are the builder's call, guided by
"shared code lives in `core/` once; role-specific behavior is a role setting
or lives under `roles/`".

## 6. The how

### 6.1 Migration (phase A: no behavior change)

1. Bring research-loop's history in with `git merge
   --allow-unrelated-histories`, its tree moved under a temporary
   subdirectory first, so `git blame` survives. Both suites green.
2. Unify the 17 files that exist in both repos, one file at a time:
   - Merge both test files and run them against one implementation. Each
     failing test exposes a real divergence.
   - Classify each divergence: (a) a fix one side has and the other lacks →
     both get it; (b) an intentional role difference → becomes a role
     setting or moves under `roles/`; (c) can't tell from code, git log and
     the two changelogs → escalate to the manager.
   - The two changelogs are evidence here: e.g. research-loop's "claim()
     throwing no longer crashes the loop" and dev-loop's "reconcile finds
     the merged PR" are candidates for one-sided fixes.
   - Record every (a) carried across in the new changelog.
3. Move skills/agents/hooks/configs/docs into the target layout.
4. Exit criterion: both roles' behavior is unchanged, both suites (now one)
   green, both roles still runnable separately via the CLI
   (`--phase research|dev` single-phase modes, used for regression only).

### 6.2 Worker identity

- `--session <name>` on the CLI; default auto-assigned `dev-<n>` (lowest n
  without a live lockfile under `.pipeline/<project>/sessions/`).
- 2.0.0 enforces **one live worker per project**: a second worker on the
  same project refuses to start and names the live one. (This is the
  stand-in for the claim step until §7.)
- Session name is written to: every run-log record (`session`), the run
  directory path, the progress log, the mirror GitHub Issue/PR body footer,
  and Jira comments posted by `src/` itself (bounce/QA-notes ADF built in
  code) as a trailing "— dev-1" line. Comments the skills post via MCP —
  including the `✅ research-loop -` spec comment `ticket-to-pr` consumes —
  are **not** changed; the session is recorded in the run log instead.
  (Builder's call: keeps A1 and the dev phase's input byte-stable.)

### 6.3 The worker cycle

1. **Poll** the project's candidate tickets (the research poll JQL, i.e.
   tickets ready to be refined, plus tickets already refined but not yet
   built — so a worker restarted mid-ticket resumes the dev phase rather
   than re-refining; "never re-refine" stays true).
2. **Blocker gate**: skip any ticket with an "is blocked by" link whose
   target isn't cleared. **Cleared = the blocker's PR is merged** (manager's
   choice, provisional until seen in practice), checked on GitHub the way
   `reconcile.ts` checks merges (including the "recorded PR closed
   unmerged, real one merged" case). A blocker with no PR, or an open PR,
   is not cleared. Log the skip with the blocking key. Neither Jira client
   fetches issue links today; the gate adds that. Make the rule a single
   function so it's cheap to change. (No PR base-branch logic in 2.0.0 —
   that is stack mode.)
3. **Claim** as research-loop does today (status transition To Do → In
   Progress; lost race = skip, claim throwing = per-ticket skip, not crash).
4. **Research phase**: spawn `claude -p "/ticket-refine <KEY>"`. Outcomes:
   - bounce → existing bounce handling; ticket stops; done.
   - green → label handoff happens immediately, regardless of
     `auto-promote` (the gate is gone; `autoPromoteLabel` is removed from
     config, and the loader rejects configs that still set it, so a stale
     config can't silently imply a gate exists).
5. **Dev phase**: spawn `claude -p "/ticket-to-pr <KEY>"` in a fresh
   process. It reads the `✅ research-loop -` comment exactly as today and
   trusts it fully. Outcomes: landed / bounced / failed, as today.
6. **Log** one record for the whole iteration, with an entry per phase, to
   the run log (§6.5) and continue polling.

**One ticket never stops the queue (manager's requirement).** When a ticket
ends blocked — research bounce, dev bounce, blocker gate, a hook failure, a
spawn failure, a claim that throws — the worker moves the ticket to the
bounced status where applicable, records why, and immediately takes the
next eligible ticket from the poll query. v1 already does this for bounces;
2.0.0 makes it a tested guarantee for every per-ticket outcome. A ticket
moved to Blocked is excluded by the poll query so it isn't re-picked. Only
worker-wide conditions pause the worker: a ceiling breach (below) and
config/auth errors that would fail every ticket.

Ceilings (builder's call):
- `maxCostPerRunUsd` / `runTimeoutMin` are per phase run (values in §6.4).
- `maxRunsPerDay` counts phase runs, kept per role (research and dev each
  get today's 100), so throughput matches v1.
- A breach keeps today's behavior: the worker pauses (`paused-ceiling`).
  The ceiling check runs **before** the research→dev label handoff, so a
  ticket whose research run breached is not handed off in that run; on the
  next start it resumes from where Jira says it is. No permanent marker.

The two phases are separate `claude -p` processes on purpose (A5): the dev
phase gets a fresh context and the written spec only, which is what keeps
"trust the ticket" honest.

### 6.4 Config

One `pipeline.<project>.config.json` per project:

```jsonc
{
  "targetRepo": { "url", "defaultBranch", "path" },
  "github": { "repo" },
  "jira": {
    "repoLabel", "statusNames": { "bounced", "prOpen" },
    "claimStatus": { "from", "to" }
  },
  "roles": {
    "research": { "triggerLabel", "handoffLabel", "pollJql",
                  "ceilings": { "maxCostPerRunUsd", "runTimeoutMin" } },
    "dev":      { "triggerLabel", "pollJql", "codeReviewFields",
                  "ceilings": { "maxCostPerRunUsd", "runTimeoutMin" } }
  },
  "ceilings": { "maxRunsPerDay" }
}
```

- Today's per-role values carry across as-is (research: $50/120 min; dev:
  $20/75 min; dev-only `codeReviewFields`).
- research-loop's stale `pollJql.dev` copy is dropped.
- `catalog-ui-public`'s `___` placeholders in dev-loop's copy are filled
  from research-loop's real values (To Do / In Progress / Blocked / Code
  Review), confirmed by the manager; its `codeReviewFields` stay `___` for
  the manager to fill.
- Loader test: for each project, each role sees exactly the values it reads
  today. Startup refuses if any value the chosen phase needs is `___`.
- Old files archived read-only under `docs/changelog/legacy-config/` until
  cutover.

### 6.5 Logs and run state

- **One record per ticket iteration** (manager's choice), not one per skill
  run. A record covers the whole research → dev pass on one ticket:
  ticket, session, `loop_version`, start/end, overall outcome, and a
  `phases` array with one entry per phase that ran (skill, skill_version,
  model, outcome, phase_reached, cost, tokens, failure_category, detail,
  PR URL for dev). `failure_category` is the closed enum `spec_ambiguous ·
  spec_contradicted · blocked · too_large · tests_flaky · env_setup ·
  verify_rejected · subagent_stall · merge_conflict · agent_error ·
  killed_ceiling · sandbox_denied` (`sandbox_denied` is the loop's own, on a
  `parked` record's `parked` field, never a skill's). A ticket that bounces in research has one phase entry; a
  ticket resumed at dev after a restart starts a new record with only the
  dev phase.
- The record is appended once the iteration ends. Live progress while it
  runs stays in the per-run `progress.jsonl`, which is already per phase.
- **Folders roll forward per major version** (manager's choice):
  - `runs/v1/` and `.pipeline/v1/` hold the existing history, moved there
    as-is. research-loop's v1 files land beside dev-loop's as
    `runs/v1/research/` and `runs/v1/dev/`. Nothing is rewritten or
    converted.
  - `runs/v2/<project>.jsonl` and
    `.pipeline/v2/<project>/<session>/<ticket>/` hold everything 2.x
    writes. Minor and patch releases stay in `v2/` and are told apart by
    `loop_version` on each record. A 3.0.0 starts `v3/`.
- **Readers that still need v1 history (builder's call):**
  - `reconcile` reads both `runs/v1/dev/` and `runs/v2/` for landed PRs, so
    tickets v1 opened PRs for are still closed out after cutover.
  - The ceiling count reads only `v2/`, and counts phase entries per role
    (§6.3).
  - `npm run stats` reports v2 by default and v1 with a flag. It reads each
    format as written, with no conversion.
- The runner passes each skill its run-directory path explicitly (as it
  already passes `DEVLOOP_DIR` to `qa-agent`); skills never derive it.
- `reset-project` gains `--role research|dev|all` (default `all` when
  resetting a ticket, since one worker now owns both phases).

### 6.6 Skills, agents, hooks, CLAUDE.md

- Contract strings stay byte-identical (A1); a test asserts the strings the
  code/skills look for match.
- Every path/repo assumption in skill/agent prose is updated (≈79
  references across `ticket-to-pr`, `qa-agent`, `ticket-refine`).
  `DEVLOOP_DIR` stays as the variable name.
- Hooks: keep all; `block-secret-comments.sh` exists in both with different
  matchers → one hook whose matcher covers both roles' write surfaces.
  research-loop's `block-github-secret-writes.sh` and
  `block-comment-edit-in-place.sh` carry over.
- `settings.json`: union, reviewed for conflicts.
- `CLAUDE.md`: rewritten so each stance is scoped to its phase — skeptic in
  research, "trust the ticket completely" in dev.
- research-loop's `.claude/reviews/part3-4-spec-draft.md` moves to
  `docs/`; `.claude/worktrees/` is local state, not migrated.

### 6.7 Changelog

- Both existing changelogs move verbatim to
  `docs/changelog/dev-loop-legacy.md` and
  `docs/changelog/research-loop-legacy.md`; never edited.
- New root `CHANGELOG.md` starts at `2.0.0`, linking both. Entries are
  tagged `[core]`, `[research]`, `[dev]`, later `[mode:stack]`. The existing
  rule (add an entry for any fix a human diagnosed from a real run) stands.

### 6.8 Cutover

0. v1 tickets that passed research but were never handed off (still
   `pipeline:research` / In Progress, awaiting the old human gate) are
   relabelled to the dev handoff label by a one-off, dry-run-first script,
   listed for the manager before it writes. (Builder's call; v2's polls
   don't otherwise match them.)
1. 2.0.0 completes one real ticket end to end (research → dev → PR) on a
   real project, with the v1 loops stopped for that project.
2. The manager confirms.
3. research-loop repo archived (not deleted); v1 dev-loop behavior is gone
   from `main` but tagged `v1-final` in git.

## 7. Designed-for: N workers per repo (not built)

Built in now so this is additive later: `session` everywhere, per-session
run dirs, worktree-per-run, one-live-worker lockfile (becomes N lockfiles).
Missing piece to build later: an atomic **dev claim** (dev-loop v1 has none)
and resume logic per session. Coordination record = Jira status/assignee or
labels + GitHub PR state; messages between sessions only ever nudge.

## 8. Designed-for: batch orchestrator + stacked PRs (not built)

Evidence and prior prototyping: `../poc-stacked-prs`
(`docs/final-recommendation.md`; router with single/epic/stack/hybrid modes,
43/43 unit tests; stacks landed 3/3 under slow review vs 0/3 for plain
chains). Its recommendation was "not yet, blocker gate first"; 2.0.0 does
the blocker gate, and the MC-863 picker work (T1 blocking four sibling
tickets, T6 on top of all four) is the concrete trigger to build stacks next.

Reference batch: the manager's hand-written run prompt for the MC-863 picker
stack (`~/Desktop/❯ give me a prompt to get htis work star…`, 2026-11-10) is
the closest thing to a working orchestrator spec today. One headless session
built the whole stack sequentially. Lessons it fixes for the orchestrator:

- **One base per PR.** MC-1646 (dialog) off main; MC-1433/1434/1437/1436 as
  siblings based on MC-1646's branch; MC-1647 (save), which depends on all
  four, is also based on MC-1646's branch with "merge after the four GET
  PRs" in its PR body. A PR can't have several parents, so a ticket with
  several blockers is based on their nearest common ancestor and its merge
  order is stated, not encoded in git. The planner must produce this.
- **Branch exists before the first edit.**
- **A blocked ticket blocks only its dependents.** The blocker is written on
  the PR, or as a Jira comment if no PR exists, and the run moves to the next
  ticket that doesn't depend on it. If the root is blocked, nothing builds.
- **Hooks are never bypassed** (`--no-verify`/`-n` are banned along with all
  force flags). A hook failure is a blocker, not something to work around.
- **No live backend.** Build fixtures from real response shapes; no writes
  to any live environment.
- **Repo-scoped guardrails come from the target repo** (generators, shadcn,
  token files off-limits), not from dev-loop. The orchestrator passes them
  through and doesn't hardcode them.
- **End-of-batch report:** one table with ticket, branch, PR URL, base, test
  status, and open questions for the manager.
- Its "one squashed commit per ticket" conflicts with dev-loop's
  RED-commit-before-GREEN rule. Builder's call: keep the RED/GREEN commits
  on the branch (they are the TDD evidence) and rely on squash-merge for one
  commit per ticket on main.

This batch becomes the first stack-mode eval scenario (synthetic copy, same
DAG shape).

Shape: a `batch-orchestrator` skill run by one dev-loop process. It reads a
batch's tickets and blocking links, plans the DAG, assigns each ticket to a
named worker in its own worktree with a base branch (main or the parent's PR
branch), runs independent tickets in parallel, and owns all stack mechanics
under the §3 rules. State is rebuilt from Jira + GitHub on restart.

## 9. Testing and evals

### 9.1 Unit tests (vitest, every change)

Mirrors `src/`. Coverage floor per `docs/logging.md` maintained. New for
2.0.0 at minimum: worker cycle (gate skip, research bounce, research green →
dev, dev outcomes, resume-at-dev after restart, ceilings per phase, every
per-ticket failure continues to the next ticket, blocked tickets not re-picked), config
loader (per-role equivalence, `___` refusal, `autoPromoteLabel` rejection),
session naming/lockfile, v2 iteration record shape, v1/v2 folder routing, reconcile across
v1 + v2, stats over each format,
reset `--role`, contract-string test, structural skill check (§9.3).

### 9.2 Evals (skill level, paid, run on skill/mode change)

`claude -p` against a synthetic sandbox repo, graded by scripts — port the
harness, fixtures and grader approach from `poc-stacked-prs/harness`.
Evals read/write real Jira tickets on `repo:webtarsthree` with the
`pipeline:v2.0.0` label (§3), created
and cleaned up by the harness; the Atlassian MCP is not stubbed (the skills'
Jira reading is part of what's under test). Scenarios for 2.0.0: clean ticket → PR; ambiguous ticket → research bounce;
research green but spec underspecified for an AC → dev bounce; blocked
ticket skipped; a queue where the first ticket bounces and the second still
lands. Add the MC-863 shape when stack mode is built.

### 9.3 Structural check (cheap, every change)

Every path a skill/agent/hook names exists; every contract string the code
greps for appears where it should; no skill hardcodes `.pipeline/`.

## 10. Left to the builder

- Internal module boundaries in `src/`, file names, CLI flag spelling beyond
  `--project`, `--session`, `--phase`.
- Order of the 17-file unification.
- Eval harness port details, grader thresholds.
- Lockfile mechanics (stale-lock detection).

## 11. Builder's calls (for the manager to check)

- Sandbox-only until cutover, enforced by project config, as the way v1 and
  v2 never collide.
- `autoPromoteLabel` removed and rejected by the loader, rather than
  silently ignored.
- Two phases as two separate `claude -p` processes.
- v1 logs frozen in `runs/v1/` with no conversion; reconcile and stats
  read v1 as-is.
- Session suffix only on `src/`-built comments, never on skill comments.
- `maxRunsPerDay` per role; ceiling check before the label handoff.
- One-off relabel of v1 refined-but-unpromoted tickets at cutover.
- Evals hit the real sandbox Jira rather than stubbing MCP.

- v2 runs on `repo:webtarsthree` behind its own `pipeline:v2.0.0` trigger label
  so it can coexist with live v1.

## 12. Revisit after real runs

- The blocker rule ("PR merged") is provisional; the manager wants to see it
  in practice. Stack mode will relax it to "PR open".
