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

- The **research-loop comment** (title starts with `✅ research-loop -`, per
  research-loop's own comment convention) is the work order. research-loop
  now always posts a brand-new comment on every re-verify/re-pickup cycle
  rather than editing an existing one in place (fixed 2026-09-19 — editing
  in place made Jira/GitHub threads look out of sync with each other even
  when the underlying state was consistent, since both surfaces render
  threads in creation-time order, not edit order), so a ticket can carry
  several matching comments over its life — always treat the
  **most-recently-created** matching comment as the work order, never the
  first one found. Treat it as
  near-perfect — do not renegotiate acceptance criteria, scope, or the
  stated fault domain. `research-loop` never rewrites a stakeholder's
  original description, so the description itself is raw context only —
  useful for background, never authoritative for AC/Scope.
- The ticket's **other comments** hold extra context (research-loop's recon
  findings, human steering notes at the review gate). Consult them when the
  research-loop comment alone leaves a judgment call, but that comment
  remains authoritative.
- **No guessing.** If an implementation decision can't be *reasoned to* from
  the research-loop comment + other comments, or the described work turns out to be larger
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
   `targetRepo.url` (same derivation as `repoSlugFromUrl` in `src/core/config.ts`
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

**Per-run worktree, nested inside the target repo itself — never work
directly in a shared checkout.** At the start of Phase 0, create an
isolated worktree for this run, on its own branch, **inside** the target
repo's own directory tree (`<targetRepo.path>/.claude/worktrees/...`, not a
sibling path elsewhere), so tools like `direnv` that activate by walking
up from the current directory pick up the target repo's own
`.envrc`/local env automatically — a worktree living outside that tree
never can. `targetRepo.path`, if set in config, is a local checkout that
already exists on this machine (its `origin` remote is the real GitHub
remote, so `git push`/`gh pr create` in Phase 5 need no extra setup).
Never work directly in `targetRepo.path` itself, since a human may `cd`
into it or be mid-inspection of a prior run's worktree at any moment
while this loop runs unattended in the background:

```bash
git -C <targetRepo.path> fetch origin
git -C <targetRepo.path> worktree add \
  <targetRepo.path>/.claude/worktrees/<TICKET>-<RUN_ID> \
  -b <TICKET>-<slug> origin/<targetRepo.defaultBranch>
cd <targetRepo.path>/.claude/worktrees/<TICKET>-<RUN_ID>
```

`<targetRepo.path>/.claude/worktrees/` is expected to be listed in that repo's
own `.git/info/exclude` (a machine-local, never-committed ignore rule) —
not this skill's job to add, but don't be alarmed that it's untracked and
outside this repo.

If `targetRepo.path` is **not** set (no local checkout on this machine
yet), fall back to a shared fetch-only clone instead, worktree nested the
same way inside it:

```bash
mkdir -p .pipeline/<SLUG>
if [ ! -d .pipeline/<SLUG>/repo/.git ]; then
  git clone <targetRepo.url> .pipeline/<SLUG>/repo
fi
git -C .pipeline/<SLUG>/repo fetch origin
git -C .pipeline/<SLUG>/repo worktree add \
  .pipeline/<SLUG>/repo/.claude/worktrees/<TICKET>-<RUN_ID> \
  -b <TICKET>-<slug> origin/<targetRepo.defaultBranch>
cd .pipeline/<SLUG>/repo/.claude/worktrees/<TICKET>-<RUN_ID>
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

### Resume: continue prior work instead of starting over

A ticket can be picked up again after a bounce (e.g. `verify_rejected`) with
its earlier commits still sitting in a `<TICKET>-*` branch. **Do not start
that work from scratch, and do not let `git worktree add -b` fail on the
existing name.** Before the `worktree add` above, after the `fetch`:

1. **Look for prior work.** List `<TICKET>-*` branches, local
   (`git branch --list '<TICKET>-*'`) and remote
   (`git branch -r --list 'origin/<TICKET>-*'`) in the checkout the worktree
   is created from. A branch only counts as prior work if it has commits not
   on `origin/<defaultBranch>` (`git rev-list --count
   origin/<defaultBranch>..<branch>` > 0); a branch with zero commits ahead
   is stale and is ignored (never reused, never deleted). Don't change the
   existing branch's name: when prior work exists, `<slug>` is that
   branch's, not a freshly derived one.
2. **None found → fresh run**, exactly the `-b <TICKET>-<slug>
   origin/<defaultBranch>` command above.
3. **Exactly one found → resume.** Create the worktree on the existing
   branch with no `-b` and no new base (`git worktree add <path>
   <branch>`). If both a local and an `origin/` copy exist, the local one
   must contain the remote one (`git merge-base --is-ancestor
   origin/<branch> <branch>`); if the two have diverged, or `worktree add`
   fails (e.g. branch checked out elsewhere), bounce `env_setup` with the
   branch names and both tips — never pick one by guessing.
   **More than one prior-work branch → bounce `env_setup`** naming them.
4. **Bring it up to date.** If `origin/<defaultBranch>` has moved, `git merge
   origin/<defaultBranch>` into the branch (merge, not rebase — the branch's
   history may already be pushed). A conflict bounces `merge_conflict`.
5. **Record it.** Write a `progress.jsonl` note: `resume: true`, the branch,
   its tip SHA, and `git log --oneline origin/<defaultBranch>..HEAD`.

What resuming changes in the phases (everything not listed is unchanged):

- **The newest research-loop spec (Phase 0 step 2) is the only work
  order.** Earlier commits are prior work against an older spec, not
  authority: where the new spec differs, the new spec wins, and existing
  code may need changing, not just extending. Still never relitigate it.
- **Phase 1 (Plan)**: first run the target repo's tests on the branch as it
  is and diff each AC against what the commits already cover. Plan only the
  remaining work: ACs with no test yet, tests the new spec adds or changes,
  and implementation still missing. Do not rewrite passing tests or
  reimplement working code.
- **Phase 2 (Red)**: only for ACs/tests that are new or changed. The
  baseline is the branch tip, not `origin/<defaultBranch>`, so an AC whose
  test already passes there because earlier commits implemented it is
  *expected*: note it as already satisfied in `progress.jsonl`; do **not**
  bounce `spec_ambiguous`. The "passes on unmodified code" bounce still
  applies to a test you just wrote for a new/changed requirement. Set
  `red_confirmed: true` if the branch already carries the original Red
  commit (`test(<TICKET>): add failing tests …`) and any new tests also
  failed for the right reason.
- **Phase 4 (Verify)**: `verify_loops` counts **this run's** `qa-agent`
  invocations, starting at 0. The 3-loop budget is per run, so a resumed
  run gets a fresh 3. Prior runs' loop counts don't carry over. Give
  `qa-agent` the research-loop spec's current text, and tell it which
  defects earlier runs already reported (from the ticket's bounce comments)
  so it checks those specifically.
- **Phase 5 (PR)**: one PR for the whole branch, not just this run's
  commits.

**Say truthfully where the work lives.** Whenever a run bounces with
commits on the branch, the bounce `detail` names the branch and states
whether it is on `origin` — check with `git ls-remote --heads origin
<branch>`, don't assume. Never write "pushed" unless that command returned
the branch. A bounce does not push (nothing unreviewed goes to the remote),
so the usual wording is "committed locally on `<branch>`, not pushed" with
the tip SHA.

## Phases

Each phase's `progress.jsonl` events use the phase name shown.

### Phase 0 — Intake

1. Fetch the ticket (`getJiraIssue`, fields: summary, description, comments,
   status, issuetype) for `$ARGUMENTS`.
2. Find the ticket's research-loop-authored comment (title starts with
   `✅ research-loop -`, per research-loop's own comment convention — see
   its `docs/future-enhancements.md`'s "Simplify Jira/GitHub comment
   templates" entry). **A ticket can have more than one matching comment**
   (research-loop always posts a new comment per cycle rather than editing
   one in place — see "Role: the executor" above) — when more than one
   Jira comment matches, use the **most-recently-created** one (by comment
   creation timestamp, not its position read top-to-bottom) as the work
   order; ignore older matching comments except as background on how the
   ticket evolved.
   - **If that comment has the `### Overview` / `### Acceptance Criteria`
     / `### Scope` structure inline**: read it directly, continue to
     step 3.
   - **If it instead has a `[GitHub Issue](url)` link** (research-loop's
     own convention: the full Overview/AC/Scope content lives on the
     linked Issue, not inline — see that repo's SKILL.md, "The GitHub
     Issue itself carries the full refined-ticket content"): fetch that
     Issue's **comments**, not its description/body —
     `gh issue view <number> --repo <owner/repo> --json comments`. The
     Issue's body/description is only ever the creation-time placeholder
     ("Mirror of [TICKET](url). ticket-refine is running...") and is
     never updated after creation — the real content is a comment whose
     first line is the markdown heading `## ✅ research-loop -
     <short context>`. The same most-recently-created rule applies here
     too: if more than one GitHub Issue comment matches that heading
     pattern, use the most-recently-created one. Read the Overview/AC/Scope
     structure from *that* comment.
   - **Stale-spec guard**: after choosing the spec comment, check whether
     any Issue comment created *after* it has a first line containing
     `research-loop` (e.g. `## Self-heal cycle 1 (research-loop verify)`,
     or a later `## ❌ research-loop -`). Such a comment means research-loop
     amended or withdrew the spec outside the `## ✅` comment this skill
     reads, so the chosen spec may be stale — bounce with
     `failure_category: "spec_ambiguous"`, detail naming the newer
     comment's id and first line. Human comments that do not mention
     `research-loop` in their first line never trigger this.
   - **If neither of the above yields the `### Overview` / `###
     Acceptance Criteria` / `### Scope` structure** (no research-loop
     comment at all, an inline comment missing the structure, or a
     `[GitHub Issue](url)` link whose Issue has no matching
     `## ✅ research-loop -` comment, or whose body is still the
     unfilled placeholder with no comment at all) — this ticket should
     never have carried the `pipeline:dev` label — bounce immediately
     with `failure_category: "spec_ambiguous"` and detail naming exactly
     which of the three cases applied. Do not attempt to proceed on an
     unreadied ticket.
3. Read every Acceptance Criterion and the Scope section's enumerated
   files/modules, from whichever source (Jira comment or GitHub Issue
   comment) step 2 resolved.
4. **Early fail-exit check**: if the enumerated scope is clearly larger than
   a single ticket's worth of work (spans many unrelated modules, requires
   architectural changes not described, etc.), bounce now with
   `failure_category: "too_large"` before doing any further work. Better to
   stop here than after writing code.
5. Set up the target repo working directory as described above.
6. **Derive `COMMIT_TYPE` from the ticket's `issuetype`** — this drives both
   the Green commit (Phase 3) and the PR title (Phase 5), and, via the
   target repo's squash-merge-as-commit-message CI convention, the semver
   bump on merge: `Bug` → `fix`; anything else (`Story`, `Task`,
   `New Feature Request`, etc.) → `feat`. A direct field mapping, not an
   inference — no judgment call to bounce over. Only add a breaking-change
   marker (`!` after the scope, or a `BREAKING CHANGE:` footer) if the
   research-loop comment itself states the change is breaking; never infer
   one from scope size.

### Phase 1 — Plan

Break the Acceptance Criteria into an ordered list of concrete steps. For
each AC, from the research-loop comment's TDD-ready Acceptance Criteria, note: the test name,
what it asserts, and why it currently fails. Write this plan as a single
note in `progress.jsonl` (not a separate file) — it exists to keep this run
honest about scope, not as a deliverable.

If, while planning, any AC cannot be translated into a concrete step without
inferring something the ticket didn't state — bounce now with
`spec_ambiguous`, naming exactly which AC and what's missing. Do this before
touching any code.

### Phase 2 — Red

For each Acceptance Criterion, in order:

1. Write the failing test named in that AC (per the research-loop comment's
   TDD-ready statement of test name / assertion / why it fails).
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

Commit once all Phase 2 tests pass, using `COMMIT_TYPE` from Phase 0
(`git commit -m "<COMMIT_TYPE>(<TICKET>): implement <summary>"`).

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
   implemented, only given the ticket and the diff. Pass it the ticket key,
   the branch name, and the absolute path of this `dev-loop` checkout (your
   own working directory, from `pwd`) so it can run `src/roles/dev/qa-browser.ts`.
   That path is for the subagent's tool calls only — never write it into
   the PR, Jira, `qa_notes`, or `verdict.json`. Each `qa-agent` invocation is one verify loop —
   increment `verify_loops` when it runs, not when a fix is committed. If
   it reports issues, address them and invoke `qa-agent` again for another
   loop; do not paper over a real finding. **The 3rd `qa-agent` invocation
   is the last one this run gets**: if it reports `pass`, continue to step
   5; if it reports `fail`, bounce immediately with `verify_rejected` and
   its findings — do not fix-and-re-check a 4th time. (Confirmed live on
   TARS-1399: a run that fixed the 3rd loop's finding and re-checked with a
   4th `qa-agent` invocation before bouncing ran to 87 minutes and tripped
   `runTimeoutMin` — the budget is 3 checks total, not 3 fix cycles plus a
   confirmation check.)
5. Record `verify_loops` (final count) for `verdict.json`.
6. **Write `qa_notes`** — sequential manual-testing steps for a human QA
   reviewer, one action per AC (or more if an AC has multiple observable
   steps): a concrete action ("Navigate to `<url>`", "Click X", "Type Y
   into Z") followed by an `Expected: <result>` entry describing what
   should happen. Build these from the research-loop comment's Acceptance
   Criteria text directly — that comment already names concrete
   routes/URLs and expected outcomes for every ticket seen so far, and this
   skill already trusts it literally per its "no inference" rule, so no
   new heuristic (diff-scanning, route-guessing) is needed here. If
   `qa-agent` reported any AC as **unverified (needs human)** (typically
   UI behind the login, which automation cannot reach), start that AC's
   action entry with `[Not verified by automation] ` so the reviewer knows
   this step is theirs alone; do not drop or soften it. Use real
   paths (e.g. `` `/rotten-tomatoes/critics?query=tina+kakad` ``), never a
   page name in prose. This becomes `verdict.json`'s `qa_notes` array (see
   schema below) and is rendered into Jira's QA Notes field as a "Manual
   testing steps:" list. The PR body's `## QA Notes` section (step 7)
   carries this **same** list, matching `push-branch`'s format — the
   earlier pass/fail summary (test counts, lint/build status, QA agent
   verdict) is no longer written into the PR; that data lives in
   `verdict.json` and `progress.jsonl`.
7. **Compose the PR content** — this is the last reasoning step; Phase 5
   below is purely mechanical and must not re-derive any of it. Produce,
   and hold for Phase 5:
   - **Title**: `<COMMIT_TYPE>(<TICKET>): <ticket summary>` (`COMMIT_TYPE`
     from Phase 0). The title matters beyond readability: the target
     repo's CI computes its semver bump from the squash-merge commit
     message on `master`, and GitHub uses the PR title as that message, so
     a correctly-typed title is what makes `feat` tickets bump minor and
     `fix` tickets bump patch on merge.
   - **Body**, in exactly this shape (same as `push-branch`'s template):

     ```markdown
     ## Jira Ticket
     JIRA_BASE_URL/browse/TICKET

     ## Changes
     - <concise bullet — what changed, not how>
     - <one bullet per AC or logical change; 3-8 bullets, single flat list>

     ## QA Notes
     Manual testing steps:

     1. <action from qa_notes entry 1>
     2. Expected: <result from qa_notes entry 2>
     ...
     ```

     Replace `TICKET` with the actual ticket key and `JIRA_BASE_URL` with
     the site URL from `getAccessibleAtlassianResources` (already called in
     Phase 0). The `## QA Notes` list is the `qa_notes` array from step 6,
     numbered, in order. No other sections — no "Core Architecture,"
     "Files Changed," "Migration Notes," or similar.
   - **Never write an absolute filesystem path into the title or body** —
     this machine's home directory is an email address, so an absolute
     path leaks PII into a PR anyone with repo access can see. Refer to
     files by repo-relative path only (e.g. `src/client/App.jsx`, not
     `/Users/<email>/Desktop/repo/src/client/App.jsx`). The same rule
     extends to any raw env var value, `.envrc`/`.env` content, or
     credential/token/key/password value — Ground/Red/Green run inside a
     per-run worktree nested inside the target repo's own directory tree
     specifically so direnv picks up its real local `.envrc`/`.env` (see
     "Target repo" below), so real secrets are reachable there too. Report
     presence/shape only, mirroring whatever `hasClientSecret`/length-only
     pattern the target repo's own app logging already uses (e.g. "reads
     `API_KEY` from env" or "token present, 42 chars"), never the literal
     value.

### Phase 5 — PR

Mechanical only. All reasoning finished in Phase 4 step 7; do not rewrite,
reorder, or "improve" the title or body here.

1. Read `~/.claude/skills/push-branch/SKILL.md` with `Read` and follow it
   exactly, in its **content supplied** mode (`--title` + `Body:`), passing:
   the title and body from Phase 4 step 7 verbatim, and `--no-jira`
   (`loop-runner.ts` owns the Jira transition and QA Notes field from
   `verdict.json`; `push-branch` must not also transition the ticket).
   Read the file rather than invoking it as a skill: `Skill` is not in
   `ALLOWED_TOOLS` (`src/main.ts`), so a nested skill call is unavailable
   in this headless run. That skill lives on the operator's machine, not in
   this repo. **If that file does not exist**, do not
   improvise your own push/`gh` steps (that would be a second copy of the
   logic): bounce with `failure_category: "env_setup"` and evidence naming
   the missing path.
2. What `push-branch` does with that input, so nothing here duplicates it:
   pushes with hooks (a failed push stops the run), then creates the PR, or
   edits it in place when one already exists for the branch (a re-run after
   a partial failure updates the PR rather than failing on a duplicate).
   Pass the title and body inline on the `gh` command line, never via
   `--body-file`.

   **The secret-content backstop still applies** — a `PreToolUse` hook
   (`.claude/hooks/block-secret-comments.sh`) denies any `gh pr create`/
   `gh pr edit` command whose content matches a known secret name or
   format pattern (see `CHANGELOG.md`'s "Round 2" entry) — but that hook
   is a heuristic backstop, not a replacement for following the Phase 4
   step 7 rule; it won't catch every shape a secret could take. The hook
   requires `jq` on PATH (its only external binary dependency); if `jq` is
   missing it fails closed and denies every Bash call, not just PR writes,
   with a message naming `jq` specifically.
   Since the hook reads the command string, the body must appear inline in
   the command — which is why `--body-file` is forbidden.

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
     `git -C <targetRepo.path or .pipeline/<SLUG>/repo, whichever it was
     created from> worktree remove
     <that checkout's path>/.claude/worktrees/<TICKET>-<RUN_ID>`. The branch
     itself lives on in the remote (landed) or in that checkout's branch
     list (bounced) either way — removing the worktree doesn't lose
     anything.
   - If the run is **bouncing with uncommitted work still in the working
     tree** (e.g. mid-Green, or Red confirmed but not yet fully
     implemented) — **keep the worktree**, and say so explicitly in the
     bounce `detail` / result line (e.g. "worktree left at
     `<targetRepo.path>/.claude/worktrees/<TICKET>-<RUN_ID>` for inspection") so a
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
  "tokens": { "in": 0, "out": 0 },
  "qa_notes": [
    "Navigate to `/rotten-tomatoes/critics?query=tina+kakad`",
    "Expected: the Self-Service badge appears next to the critic's name"
  ]
}
```

`cost_usd` and `tokens` are left as `0`/zeros by this skill — the loop
runner derives the real values from `claude -p --output-format json`'s own
usage report, not from anything this skill self-reports (a skill cannot
reliably know its own total cost from inside the run).

`qa_notes` is optional — omit it (or write an empty array) on a `bounced`
or `error` outcome with nothing to report; the loop runner falls back to
a PR-link stub in that case. On a `landed` outcome, always populate it per
Phase 4 step 6 above. The PR body's `## QA Notes` (Phase 4 step 7) carries
this same list.

## Invocation (for the loop runner)

```
claude -p "/ticket-to-pr <TICKET-KEY>" --model sonnet --permission-mode acceptEdits --output-format json
```

`--model sonnet` is explicit, not ambient-default — this skill is the
literal-minded executor tier per the spec (§5.0), never the tier that
questions the spec. `qa-agent` pins its own model in its frontmatter and does
not inherit this invocation.
