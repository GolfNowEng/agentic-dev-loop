# Future Enhancements

Ideas for the pipeline itself (not tickets it processes) that are worth
doing but not yet drafted into a change. Unlike `CHANGELOG.md` (landed
fixes), this is a holding pen — write down the idea and the evidence that
motivated it, then leave it for later. When one of these actually gets
implemented, move its entry to `CHANGELOG.md` and delete it from here.

## Cheap-tier gate for test-only tickets (Step 0, ticket-refine)

**Idea**: add a triage-time check in `ticket-refine`'s Step 0 (Triage &
route) that recognizes a narrow ticket class — new test coverage only,
zero application-code changes, no new runtime behavior — and runs a
lighter pipeline for it: skip or shrink Attack's empirical
build-and-run-a-scratch-test step, and rely on Verify's static check
instead. Everything else (Ground's currency check, Synthesize, Verify)
stays as-is; this is scoped to the one most expensive step for the one
lowest-risk ticket class.

**Why**: on `TARS-1284` (add ~8 new tests to one new file, no changes to
`FormReviews.jsx` itself), the full run took ~47 minutes wall-clock. Of
that, Attack alone took ~13 minutes because `devils-advocate-agent`
built and ran a real scratch integration test to verify a test-file
mocking pattern. That's the right level of scrutiny for a ticket that
could break production behavior — but this ticket touched no production
code at all, so the blast radius of being slightly wrong is much smaller
than what Attack's cost is calibrated for. See `progress.jsonl` in
`.pipeline/webtarsthree/runs/TARS-1284-20260827T225552Z/` for the phase
timestamps this estimate is based on.

**Not yet scoped**: exact detection rule for "test-only ticket" (likely:
Scope's own files-to-touch enumeration, checked *before* Attack rather
than after); how much to shrink Attack (skip entirely vs. drop just the
empirical-build sub-step); whether this should be a new Step 0 branch or
a flag Ground/Attack read.

## `claim()` doesn't send a claim-transition's required screen fields

**Idea**: `RealJiraClient.claim` (`src/jira-client.ts:216`) transitions a
ticket via whatever transition leads to `claimStatus.to`, but only ever
sends `{ transition: { id } }` — no `fields`. If that transition's screen
has a field Jira enforces as required at submit time, the claim call
throws and the whole loop iteration dies uncaught (see the `main.ts:480`
stack trace from the fatal-error run below), rather than being treated as
a per-ticket skip/bounce the way a lost claim race already is.

**Why**: hit live on `TARS-1460` (a real smoke-test ticket for the Phase 0
label-trigger change) — its `claimStatus` transition in TARS's workflow is
"Start Development" (id `421`, `To Do` → `In Progress`), whose screen has
a `Story Points` (`customfield_10002`) field. `getTransitionsForJiraIssue`
reports that field as `required: false` in its own metadata, but the live
`POST .../transitions` call rejected the same transition with `400 Bad
Request: "Field 'Story Points is required.'"`. Same *class* of bug as the
undocumented parent-Epic requirement already known for Bug/Story/Tech
Story create calls (`configs/TARS.json` in the sibling `skills` repo's
`jira-create-ticket`) — Jira's create/transition metadata under-reporting
a real requirement — just hitting a different operation (claim/transition
in research-loop itself, not issue creation in `jira-create-ticket`).
Worked around for this one ticket by setting Story Points directly via
`editJiraIssue` before retrying the loop; not yet fixed in `claim()`.

**Not yet scoped**: whether to have `claim()` fetch the target
transition's screen fields (same call shape as `getTransitionsForJiraIssue`
already returns) and supply a configured default for any it finds
required, or something narrower (e.g. a config-level "extra transition
fields" map per project, since "what value" has no universal right
answer — Story Points has no meaningful default for a research-loop-only
ticket). Also unscoped: whether a claim failure of this shape should
become a new terminal outcome (distinct from today's clean lost-race
`false` return) or whether the loop runner should catch it and treat it
as `outcome: "error"` for that iteration rather than crashing the whole
process — right now it's an uncaught throw all the way out of `main`.

## Jira label-based trigger (both repos) + split Jira (PM) / GitHub Issues (research & dev)

**Idea**: replace Jira's epic-parent trigger with a Jira label-based
trigger, in both research-loop and dev-loop together (uniform across
project types, no more `epicLinkField` per-project variance, and no gap
where dev-loop stops being triggered). Then, once that's solid, split what
Jira carries from what GitHub Issues carries: Jira becomes pure PM
surface — clean ticket, a handful of templated must-know comments (always
@-mentioning the assignee), status/label only. All trigger logic and
heavy dev/research commentary move to a GitHub Issue that mirrors the
Jira ticket 1:1, using the *same* label vocabulary on both systems.

**Why**: today's fixed-title-comment convention (`Refined Spec — ready for
ticket-to-pr`, `Ticket-Refine Bounce — <category>`, both in
`.claude/skills/ticket-refine/SKILL.md`) hasn't kept Jira clean — Jira is
cluttered despite it existing, because there's no enforcement and no
routing rule separating product-level content from engineering-in-the-
weeds content. Separately, `Config.jira.epicLinkField`'s per-project-type
variance (`"parent"` for team-managed projects, a
`customfield_XXXXX` for company-managed ones, per `docs/config.md`) is a
real onboarding cost a label-based trigger removes outright, in both
repos — directly relevant to onboarding `catalog-ui-management` and
`catalog-ui-public` next. GitHub Issues is a more natural home for
dev-shaped conversation (markdown, code refs, multi-label state,
closes-via-PR) and becomes queryable "second brain" infrastructure
dev-loop can eventually read from directly.

**Label taxonomy** (shared stage vocabulary across Jira and GitHub; status
vocabulary scoped *per stage*, not one flat shared list — a two-pass
correction, see below):
- **Stage** (mutually exclusive, one at a time — mirrors today's two
  epics, and now also doubles as each repo's poll trigger):
  `pipeline:research` (research-loop's poll target), `pipeline:dev`
  (dev-loop's poll target, replacing `readyEpic` membership),
  `pipeline:merged` (terminal — reached only via the reconciliation pass
  below, never at PR-open time).
- **Status** (independent of stage, can co-occur with the current stage —
  fixes a documented Jira limitation: `docs/config.md` notes today "still
  being refined" and "refined, awaiting approval" look identical on the
  board since both share one epic). Scoped into two separate pools rather
  than one shared list, since research-loop's and dev-loop's statuses
  describe genuinely different situations:
  - Research-loop statuses (valid only while stage is `pipeline:research`):
    `pipeline:blocked`, `pipeline:bounced`, `pipeline:needs-product-input`.
  - Dev-loop statuses (valid only while stage is `pipeline:dev`):
    `pipeline:pr-open`, plus whatever else dev-loop's own bounce/blocked
    states need (deferred — see below).
  - Both pools stay in the same flat `pipeline:*` namespace (no new
    prefix) — a GitHub Issues list view still reads as exactly two badges
    per row, stage + status, that always make sense together.
- **An open PR is not, by itself, grounds for `pipeline:merged`**: stage
  stays `pipeline:dev` for the life of an open PR; only the status label
  changes, to `pipeline:pr-open`, applied at the existing PR-open moment
  (today's `statusNames.prOpen` Jira transition — no new trigger, just
  also labels it). `pipeline:merged` is reached *only* by dev-loop's
  startup reconciliation pass (below) confirming a real merge via
  `gh pr view --json state,mergedAt` — never inferred from anything short
  of a confirmed merge. This makes "PR open, not yet merged" a real,
  visible state instead of being indistinguishable from either
  `pipeline:dev` (not started) or `pipeline:merged` (actually done).
- Stage-label swap points are tied to transitions that already exist
  today: `pipeline:research` applied at claim (today's atomic status
  transition); swapped to `pipeline:dev` at the point the epic would move
  to `readyEpic` today — this swap is now the actual trigger dev-loop
  polls for; swapped to `pipeline:merged` only via the reconciliation
  pass, clearing `pipeline:pr-open` at the same moment.
- **Who performs the `pipeline:research`→`pipeline:dev` swap is an exact
  1:1 carry-over of today's `Config.autoPromoteLabel` semantics**
  (`src/loop-runner.ts:178`) — a distinct, unrelated mechanism, not to be
  conflated with the new stage/status labels. Default: research-loop
  never swaps the label itself on a passing verdict — the ticket sits at
  `pipeline:research` until the user manually swaps it to `pipeline:dev`,
  after reviewing both the Jira ticket and the mirrored GitHub Issue.
  Only when `autoPromoteLabel` is present on the ticket does research-loop
  perform the swap automatically — identical to today's "move the epic
  automatically" behavior, just acting on a label instead of an epic. This
  preserves the human-in-the-middle default for two reasons: dev-loop is a
  separate local process that still has to be started by hand regardless
  of label state, and the option to read GitHub-mirrored comments before
  signing off only holds if the label swap itself defaults to manual.

**Routing rule** (Jira vs. GitHub content split):
- Jira-worthy, and *only* these: a blocking ambiguity needing a human
  product decision, a scope call, an explicit confirmation request, or a
  passing-verdict pointer. No per-comment judgment call beyond this list.
- GitHub-only: recon findings, devil's-advocate attack findings, verifier
  results, working/interpretation notes, bounce evidence detail — anything
  in-the-weeds/engineering-shaped. Still concise, allowed to be technical.
- Any comment that does reach Jira must @-mention the assignee — a new
  requirement, no such convention exists today. Needs a config field for
  who to mention, sourced the same way `JIRA_ASSIGNEE_ACCOUNT_ID`/
  `assigneeAccountIdFromEnv` already works in `src/jira-client.ts`, not a
  new secret-shaped env var.

**Proposed model**:
- Jira: ticket stays put; comments trimmed to the routing rule above. The
  existing fixed-title convention is kept but its content shrinks to a
  short pointer once dev-loop migrates ("see GitHub issue #123 for full
  evidence") plus an @-mention. Ticket *status* transitions (`claimStatus`,
  `statusNames.bounced/prOpen`) are untouched by this proposal.
- GitHub Issues: one Issue per Jira ticket, created early (sketch: during
  `ticket-refine`'s existing Step 0/intake, right after claim — exact step
  needs its own design pass). Title convention: `<JIRA-KEY>: <ticket
  summary>`. Body mirrors the Jira ticket's must-know fields at creation
  time; recon/attack/verify/working content posted as comments per the
  routing rule. Cross-link is a plain URL in a comment on both sides — the
  Atlassian MCP toolset has no structured remote-link-creation tool
  (`createIssueLink` only links two Jira issues to each other;
  `getJiraIssueRemoteIssueLinks` is read-only), so this is a real tooling
  constraint, not an oversight.
- Per-project config: each project already has its own
  `pipeline.<project>.config.json`; adding a `github.repo` field per
  project file is how `catalog-ui-management` and `catalog-ui-public` each
  get their own target repo — no new mapping structure needed. Sketch
  (research-loop's config; dev-loop's mirrors it with `pipeline:dev` as
  its own `triggerLabel`):
  ```json
  "jira": {
    "triggerLabel": "pipeline:research",
    "readyLabel": "pipeline:dev",
    "mentionAccountId": "<jira-account-id-for-@mentions>"
  },
  "github": {
    "repo": "org/repo",
    "stageLabels": { "research": "pipeline:research", "dev": "pipeline:dev", "merged": "pipeline:merged" },
    "researchStatusLabels": { "blocked": "pipeline:blocked", "bounced": "pipeline:bounced", "needsProductInput": "pipeline:needs-product-input" },
    "devStatusLabels": { "prOpen": "pipeline:pr-open" }
  }
  ```
  `researchStatusLabels`/`devStatusLabels` are two separate pools, not one
  flat `statusLabels` map, so a future reader doesn't have to guess which
  statuses are valid for which stage. Explicitly distinct from
  `autoPromoteLabel` — do not conflate.
- Code-level enforcement, two separate hooks in two separate phases: (a) a
  `PreToolUse` hook on `mcp__atlassian__addCommentToJiraIssue` that rejects
  a comment violating the routing rule (size, shape, missing @-mention) —
  only matters once Jira content is actually being trimmed; (b) a
  `PreToolUse` hook on the new GitHub write surface that hard-denies via
  `containsSecret()`/`redactSecrets()` (`src/redact.ts`, already wired into
  the existing Jira/Confluence hook) before any write reaches GitHub — a
  mandatory launch blocker, no fast-follow, since GitHub carries real
  ticket/codebase content from day one it's introduced. Both modeled on
  dev-loop's `.claude/hooks/block-secret-comments.sh` (fail-closed
  contract: stdin-only data handling, distinct non-1 exit codes so a crash
  isn't mistaken for a clean check) — the GitHub hook also needs
  dev-loop's `Bash`-command-text matching style (whole-word checks on `gh`,
  `pr`, `create|edit`) adapted, since `gh`/octokit calls aren't a named MCP
  tool the way Jira calls are.
- **Status sync on merge is a startup-time reconciliation pass, not a new
  poller, webhook, or process** — nothing else in this design actually
  performs the `pipeline:dev`→`pipeline:merged` swap or the GitHub Issue
  close; GitHub's `Closes #<issue>` convention auto-closes the Issue on
  merge (real, native behavior), but nothing relabels it and nothing on
  the Jira side reacts to a GitHub merge event at all. Fix: dev-loop, at
  the top of its existing loop iteration (before each poll cycle, not a
  separately-scheduled job), runs a small reconcile step — its own
  lightweight, cheap-tier-model skill the main loop agent invokes, since
  this is a bounded mechanical check, not reasoning-heavy work — that
  finds tickets/Issues at stage `pipeline:dev` with status
  `pipeline:pr-open`, checks each one's real merge state via `gh pr view
  <n> --json state,mergedAt` (dev-loop already shells out to `gh` for PR
  creation — no new tool, no new credential), and for any that merged
  since the last cycle: swaps stage to `pipeline:merged` on both Jira and
  the GitHub Issue (clearing `pipeline:pr-open`), and explicitly closes
  the GitHub Issue (needed because a merge that happened while dev-loop
  was offline can't assume the auto-close already ran). This mirrors the
  pattern of reconciling state at a natural checkpoint rather than adding
  a continuously-running watcher — no GitHub Actions workflow, no
  standalone cron job. Needs its own idempotency guard: re-running it on a
  ticket already at `pipeline:merged` must be a safe no-op, not a
  duplicate swap or a re-close error on an already-closed Issue.

**Phased rollout** — three phases, not combined into one change:
- **Phase 0 (Jira-only, both repos, no GitHub involved yet) — DONE, see
  CHANGELOG.md.** Replaced epic-parent polling with label polling in both
  research-loop and dev-loop together — research-loop's `src/jql.ts`
  templates changed from `parent in ({epics})` to a `pipeline:research`
  label match; dev-loop's poll JQL changed from `parent = {epic} AND
  status = "In Progress"` to a `pipeline:dev` label match. Without this,
  once research-loop's approval step stopped moving the epic, dev-loop's
  existing trigger would never fire again — there's no "later" for
  dev-loop's trigger, so both repos moved together. The claim step was
  unchanged; the "approval" step (previously: move epic to `readyEpic`,
  gated by `autoPromoteLabel`) became the `pipeline:research`→
  `pipeline:dev` label swap, governed by the exact same manual-default/
  `autoPromoteLabel`-gated-automatic rule, and that swap is now the real
  handoff mechanism between the two repos. TDD'd in both repos; epics
  remain in Jira for board/PM use only, read by neither loop.
- **Phase 1 (research-loop creates/mirrors GitHub, dual-write) — DONE, see
  CHANGELOG.md.** Jira keeps getting the full `Refined Spec` comment
  unchanged — dev-loop keeps reading it as its work order, untouched (only
  its trigger changed in phase 0). research-loop also creates/mirrors the
  GitHub Issue and posts full recon/attack/verify detail there per the
  routing rule. The GitHub secret-redaction hook landed as a prerequisite
  gate before any of this content shipped, per the plan. dev-loop's
  startup-time merge-reconciliation pass (once a GitHub Issue exists per
  ticket, moving both a Jira label and a GitHub Issue to
  `pipeline:merged`) did not land in this phase and remains open — see
  below.
- **Phase 2 (Jira decluttered — dev-loop migrated)**: once dev-loop's
  `ticket-to-pr` is changed to read its work order from the GitHub Issue
  instead of the Jira comment, the Jira `Refined Spec` comment shrinks to
  a pointer + @-mention, and the Jira-comment-shape hook goes live. This
  is the point Jira actually becomes clean. Requires its own dev-loop-side
  design/sign-off round — a bigger, riskier change than phase 0's
  mechanical trigger swap, correctly deferred.

**Architecture touchpoints**: `src/jql.ts`, `src/loop-runner.ts`,
`docs/config.md`'s `epicLinkField` section (research-loop) and dev-loop's
equivalent poll-JQL/config files — phase 0's actual replacement surface,
in both repos. `src/types.ts` `Config` needs a new `github` block plus
`jira.triggerLabel`/`readyLabel`/`mentionAccountId`. `JiraClient`'s
injected-interface shape is worth mirroring for a new `GitHubClient`;
`test/jira-client.test.ts`'s `vi.stubGlobal("fetch", fetchMock)` pattern
is the concrete TDD starting point, per CLAUDE.md's "TDD, strictly, for
this repo's own code" rule. GitHub Issues has no atomic-claim primitive
the way a Jira status transition does — a label add is not race-safe —
but this only matters once something polls GitHub directly (dev-loop in
phase 2); flagged as its own design pass then. `.claude/skills/
ticket-refine/SKILL.md` is the only place that writes Jira comments today
and where the routing-rule/@-mention logic and label swaps get
implemented. GitHub Issue creation needs an idempotency check (does an
issue for this Jira key already exist) before creating, to avoid
duplicates from the same class of poll-loop race the `postRunDelaySec` fix
addressed. Cross-repo coordination today is "through Jira ticket state"
(per README.md) — phase 0 changes *how* that happens (label instead of
epic-move) but not *that* it happens through Jira; phase 2 is the first
design pressure to move the coordination substrate itself to GitHub.

**Not yet scoped / explicitly deferred**: PR lifecycle edge cases (PR
closed without merge — the reconciliation pass only handles
`merged=true`, so a closed-without-merge PR leaves a ticket stuck at
`pipeline:dev`/`pipeline:pr-open` indefinitely; PR replaced by a new one;
multiple branches mapping to the same Jira key/GitHub Issue); Jira
parent/child subtasks mapping to one vs. many GitHub Issues; GitHub's
concurrency-safe claim mechanism (needed once dev-loop polls GitHub
directly in phase 2); exact content/thresholds for the Jira-comment-shape
hook; whether dev-loop reads/writes the same Issue or gets its own linked
Issue in phase 2; whether dev-loop needs status labels of its own beyond
`pipeline:pr-open` (`devStatusLabels` in the config sketch above is
deliberately left open for this — dev-loop's `SKILL.md`/verdict
categories haven't been checked for a 1:1 fit); dev-loop's startup-time
merge-reconciliation pass itself (Phase 1's own description called for it,
but it targets dev-loop, not research-loop, and did not land as part of
this plan).

**Resolved by this plan** (design decisions the doc above had left open,
now settled): (a) GitHub Issue creation happens in `main.ts`'s composition
root, right after claim — not inside `ticket-refine`'s own Step 0/intake
turn — so the skill can assume the mirrored Issue already exists by the
time it runs; (b) the cross-link format is exactly the plain URL in a
comment on both sides already sketched above — no structured remote-link
tool was added, since none was needed beyond what the doc already
specified.
