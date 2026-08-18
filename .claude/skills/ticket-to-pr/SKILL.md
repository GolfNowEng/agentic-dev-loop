---
name: ticket-to-pr
description: Turn a single ready Jira ticket into a PR against the target repo (webtarsthree) using strict TDD phases. The executor role (spec section 5.0/5.2) - trusts the refined ticket completely, never relitigates the spec, bounces with evidence instead of guessing.
---

# ticket-to-pr

## Arguments

`$ARGUMENTS` — a single Jira ticket key, e.g. `TARS-1301`. Required.

## Role: the executor

Per spec section 5.0, this skill runs **downstream of the human review gate**
and operates under full trust of the refined ticket:

- The ticket's **description** is the work order. Treat it as near-perfect —
  do not renegotiate acceptance criteria, scope, or the stated fault domain.
- The ticket's **comments** hold extra context (original raw description,
  research-loop's recon findings, human steering notes at the review gate).
  Consult them when the description alone leaves a judgment call, but the
  description remains authoritative.
- **No guessing.** If an implementation decision can't be *reasoned to* from
  the description + comments, or the described work turns out to be larger
  than stated, stop and bounce with exactly what was missing. A ticket is
  never edited by this skill — if the spec is wrong, ambiguous, or
  unimplementable as written, that is `ticket-refine`'s problem to fix
  upstream, not this skill's to patch over.

A stated "I stopped because X" is a success mode of this pipeline. A guessed
implementation is its worst failure mode.

## Setup: run directories and progress logging

Before phase 0, establish:

1. `RUN_ID` = current UTC timestamp as `YYYYMMDDTHHMMSSZ`.
2. `SLUG` = the project slug derived from `pipeline.<project>.config.json`'s
   `targetRepo.url` (same derivation as `repoSlugFromUrl` in `src/config.ts`
   — the last path segment, minus a trailing `.git`), e.g. `webtarsthree`.
3. `RUN_DIR` = `.pipeline/<SLUG>/runs/<TICKET>-<RUN_ID>/` (relative to this
   repo's root, i.e. `dev-loop/`, NOT the target repo checkout). Create it.
   Namespacing by `SLUG` lets multiple projects' runs coexist under one
   `dev-loop` checkout without collision.
4. Every phase transition appends one JSON line to `RUN_DIR/progress.jsonl`
   (create the file with the first append). Never rewrite or delete existing
   lines — append-only, same discipline as `runs/<SLUG>.jsonl`. Each line:
   ```json
   {"ts": "<ISO-8601 UTC>", "phase": "intake|plan|red|green|verify|pr", "event": "phase_start|phase_end|note", "detail": "one line"}
   ```
   - Emit `phase_start` when beginning a phase, `phase_end` when leaving it
     (whether it succeeded or the run is about to bounce from within it).
   - Emit a `note` event for anything worth surfacing mid-phase (e.g. "wrote
     3 failing tests", "existing suite has 412 tests, 0 failing before
     changes", "QA subagent flagged a null-check gap").
5. At the very end of the run — success or bounce, no exceptions — emit one
   final `progress.jsonl` line with `"event": "result"` whose `detail` is the
   same human-readable summary described in "Always-emitted result line"
   below, then print that same line to stdout as the last thing this skill
   does.

This progress log is deliberately separate from `verdict.json`: it exists so
a dashboard (built separately, not by this skill) can show what happened
inside a run while or after it happened, without needing to parse model
output. Only append to it — never read it back to make decisions; all
decision-relevant state lives in the ticket, the target repo, and this
skill's own working context.

## Always-emitted result line

Whatever phase the run ends at, the last thing this skill does is emit one
line, to stdout and as the final `progress.jsonl` event and as
`verdict.json`'s `detail` field, in one of these forms:

- `RESULT: landed — PR opened at <url>`
- `RESULT: bounced (<failure_category>) — <one-line reason with concrete evidence>`
- `RESULT: error — <what went wrong>` (only for genuine tooling/environment
  failures, not spec problems — spec problems are always `bounced`)

This is the single line a human skimming a terminal or a future dashboard
should be able to read to know what happened, without opening any other
file.

## Target repo

This repo's `pipeline.<project>.config.json`'s `targetRepo` field names the
codebase this skill operates on — currently `pipeline.webtarsthree.config.json`
points at `webtarsthree` (`git@github.com:fandango/webtarsthree.git`, default
branch `master`). This is **not** the `dev-loop` repo itself; `dev-loop` only
orchestrates. Adding a second project later means adding a second
`pipeline.<project>.config.json` — no code or skill changes.

**Shared clone, per-run worktree — never work directly in the shared
clone.** `.pipeline/<SLUG>/repo` (`SLUG` as derived in "Setup" above) is a
`git clone` of `targetRepo.url` kept up to date with `git fetch` **only** —
no run ever checks out a branch or resets *this* directory, because a human
may `cd` into it, or be mid-inspection of a prior run's worktree, at any
moment while this loop runs unattended in the background. Instead, at the
start of Phase 0, create an isolated worktree for this run, on its own
branch:

```bash
mkdir -p .pipeline/<SLUG>
if [ ! -d .pipeline/<SLUG>/repo/.git ]; then
  git clone <targetRepo.url> .pipeline/<SLUG>/repo
fi
git -C .pipeline/<SLUG>/repo fetch origin
git -C .pipeline/<SLUG>/repo worktree add \
  .pipeline/<SLUG>/worktrees/<TICKET>-<RUN_ID> \
  -b <TICKET>-<slug> origin/<targetRepo.defaultBranch>
cd .pipeline/<SLUG>/worktrees/<TICKET>-<RUN_ID>
```

(Three distinct identifiers here: `<SLUG>` uppercase is the *project* slug
from the config path; `<RUN_ID>` is this run's timestamp, keeping this run's
worktree separate from any other run's, past or concurrent; `<slug>`
lowercase in the branch name is the per-ticket kebab-case summary described
next — the branch name itself has no `<RUN_ID>` in it, since it's what gets
pushed and PR'd.)

`<slug>` is a short kebab-case summary derived from the ticket's summary
(lowercase, non-alphanumeric → `-`, truncate to a reasonable length — e.g.
`TARS-1301-delete-tv-objects`). All subsequent phases operate with this
worktree as the working directory unless stated otherwise. See "Cleanup"
below for removing it once the run concludes.

## Phases

Each phase's `progress.jsonl` events use the phase name shown.

### Phase 0 — Intake

1. Fetch the ticket (`getJiraIssue`, fields: summary, description, comments,
   status) for `$ARGUMENTS`.
2. Confirm the description follows the definition-of-ready template from
   `ticket-refine` (`### Overview`, `### Acceptance Criteria`, `### Scope`).
   If it doesn't — this ticket should never have reached the Ready epic —
   bounce immediately with `failure_category: "spec_ambiguous"` and detail
   noting the missing sections. Do not attempt to proceed on an unreadied
   ticket.
3. Read every Acceptance Criterion and the Scope section's enumerated
   files/modules.
4. **Early fail-exit check**: if the enumerated scope is clearly larger than
   a single ticket's worth of work (spans many unrelated modules, requires
   architectural changes not described, etc.), bounce now with
   `failure_category: "too_large"` before doing any further work. Better to
   stop here than after writing code.
5. Set up the target repo working directory as described above.

### Phase 1 — Plan

Break the Acceptance Criteria into an ordered list of concrete steps. For
each AC, from the ticket's own TDD-ready description, note: the test name,
what it asserts, and why it currently fails. Write this plan as a single
note in `progress.jsonl` (not a separate file) — it exists to keep this run
honest about scope, not as a deliverable.

If, while planning, any AC cannot be translated into a concrete step without
inferring something the ticket didn't state — bounce now with
`spec_ambiguous`, naming exactly which AC and what's missing. Do this before
touching any code.

### Phase 2 — Red

For each Acceptance Criterion, in order:

1. Write the failing test named in that AC (per the ticket's TDD-ready
   description of test name / assertion / why it fails).
2. Run it. Confirm it actually fails, **and fails for the expected reason**
   (not e.g. a typo or missing import producing an unrelated error).
3. If a test passes against unmodified code, the AC doesn't describe a real
   change — bounce with `spec_ambiguous`, stating which AC and that its test
   passed on baseline code.

Once every AC's test is written and confirmed failing for the right reason,
record `red_confirmed: true` (this goes into `verdict.json` later) and
commit the tests alone, before any implementation code
(`git commit -m "test(<TICKET>): add failing tests for ACs"`).

### Phase 3 — Green

Implement the minimum change to make the Phase 2 tests pass. Touch **only**
the files enumerated in the ticket's Scope section. If implementing
correctly requires touching a file not enumerated, or reveals the described
bug isn't reproducible, or an AC turns out unimplementable as written — stop
and bounce with `spec_contradicted` (codebase evidence contradicts the
ticket's claim) or `spec_ambiguous`, citing the specific contradiction.

Commit once all Phase 2 tests pass
(`git commit -m "feat(<TICKET>): implement <summary>"`).

### Phase 4 — Verify

1. Run the full existing test suite. It must be 100% green. If it's not,
   and the failure is unrelated to this change, bounce with `tests_flaky`
   naming the failing test(s); if the failure is caused by this change,
   that's a Green-phase defect — go back and fix it, do not proceed to PR
   with a broken suite.
2. Run whatever the target repo's own CI would run beyond tests — lint,
   typecheck, and build, at minimum (check the target repo's own CI config
   or `package.json` scripts for the actual commands; don't assume names).
   A PR that passes tests but fails lint/typecheck/build on push is not a
   `landed` success, it's a deferred bounce — catch it here, not after
   opening the PR. Treat a failure here the same as a test failure: fix it
   if it's caused by this change, or bounce `tests_flaky`/`env_setup` (pick
   whichever fits) with the concrete output if it's pre-existing and
   unrelated.
3. Confirm the new tests from Phase 2 are present and passing, and that
   TDD order is real in git history (test commit before implementation
   commit — already true if Phase 2/3 were followed in order).
4. Spawn `qa-agent` (see `.claude/agents/qa-agent.md`) as a genuine
   fresh-context subagent — it must not be told how the fix was
   implemented, only given the ticket and the diff. Pass it the ticket key
   and the branch name. If it reports issues, address them and re-run this
   phase (increment a `verify_loops` counter each time); do not paper over
   a real finding. If after 3 verify loops issues persist, bounce with
   `verify_rejected` and the QA agent's findings.
5. Record `verify_loops` (final count) for `verdict.json`.

### Phase 5 — PR

1. Push the branch: `git push -u origin <TICKET>-<slug>`.
2. Open the PR (via `gh pr create` or equivalent) against
   `targetRepo.defaultBranch`, title `<TICKET>: <ticket summary>`, body
   summarizing what changed, which tests were added, and verification
   results (existing suite status, lint/typecheck/build status, QA agent
   outcome).
3. Write `verdict.json` in `RUN_DIR` (see schema below) with
   `outcome: "landed"`, `phase_reached: "pr"`, the PR URL, and all recorded
   metrics.
4. Run Cleanup (see below), then emit the always-emitted result line and
   stop.

## Cleanup (hard gate, every run)

Before this skill's final result line — regardless of outcome (landed,
bounced at any phase, or error):

1. **If you (or `qa-agent`) started the target repo's dev server, stop it.**
   Confirm it's actually stopped (e.g. the port is free), not just that you
   sent a stop signal.
2. **Remove this run's worktree** — with one exception:
   - If the run **landed** (branch pushed, PR open) or **bounced with all
     in-progress work already committed** — remove it:
     `git -C .pipeline/<SLUG>/repo worktree remove
     .pipeline/<SLUG>/worktrees/<TICKET>-<RUN_ID>`. The branch itself lives
     on in the remote (landed) or in `.pipeline/<SLUG>/repo`'s branch list
     (bounced) either way — removing the worktree doesn't lose anything.
   - If the run is **bouncing with uncommitted work still in the working
     tree** (e.g. mid-Green, or Red confirmed but not yet fully
     implemented) — **keep the worktree**, and say so explicitly in the
     bounce `detail` / result line (e.g. "worktree left at
     `.pipeline/<SLUG>/worktrees/<TICKET>-<RUN_ID>` for inspection") so a
     human or `ticket-refine`'s revision pass can inspect exactly what was
     tried. This is the only case where cleanup is conditional — everything
     else removes the worktree unconditionally.

Both apply even if you never reached Phase 0's worktree setup (nothing to
clean up, but check before assuming so) and even if the run is about to
bounce or error out. Aside from the single uncommitted-work exception
above, this is not conditional on how the run concludes.

## Bouncing (any phase)

A bounce is a normal, successful exit of this skill — not a crash. On any
bounce:

1. Run Cleanup (see above) — it applies regardless of why this run is
   ending; a bounce is not an exception to it, aside from the one
   uncommitted-work case Cleanup itself carves out.
2. Write `verdict.json` with `outcome: "bounced"`, the `phase_reached` you
   stopped at, a `failure_category` from the closed enum (see below), and a
   `detail` string with concrete evidence (file paths, test output excerpts,
   the specific AC or scope line that's the problem) — never a vague "this
   was unclear."
3. Emit the always-emitted result line and stop. Do not attempt any further
   phases.

**Closed failure_category enum** (never invent new values):
`spec_ambiguous · spec_contradicted · blocked · too_large · tests_flaky · env_setup · verify_rejected · subagent_stall · merge_conflict · agent_error · killed_ceiling`

This skill will only ever self-report `spec_ambiguous`, `spec_contradicted`,
`too_large`, `tests_flaky`, `verify_rejected`, `env_setup`, `merge_conflict`,
or `blocked` — the remaining categories (`subagent_stall`, `agent_error`,
`killed_ceiling`) are the loop runner's own failure modes, not this skill's.

## verdict.json schema

Write to `RUN_DIR/verdict.json` (never elsewhere — the loop runner reads it
from this exact path):

```json
{
  "outcome": "landed | bounced | error",
  "phase_reached": "intake | plan | red | green | verify | pr",
  "failure_category": null,
  "detail": "the always-emitted result line's content, without the RESULT: prefix",
  "red_confirmed": true,
  "verify_loops": 1,
  "retries": 0,
  "skill_version": "<git SHA of this SKILL.md's commit in dev-loop>",
  "model": "sonnet",
  "pr": "https://github.com/fandango/webtarsthree/pull/123",
  "cost_usd": 0,
  "tokens": { "in": 0, "out": 0 }
}
```

`cost_usd` and `tokens` are left as `0`/zeros by this skill — the loop
runner derives the real values from `claude -p --output-format json`'s own
usage report, not from anything this skill self-reports (a skill cannot
reliably know its own total cost from inside the run).

## Invocation (for the loop runner)

```
claude -p "/ticket-to-pr <TICKET-KEY>" --model sonnet --permission-mode acceptEdits --output-format json
```

`--model sonnet` is explicit, not ambient-default — this skill is the
literal-minded executor tier per the spec (§5.0), never the tier that
questions the spec. `qa-agent` pins its own model in its frontmatter and does
not inherit this invocation.
