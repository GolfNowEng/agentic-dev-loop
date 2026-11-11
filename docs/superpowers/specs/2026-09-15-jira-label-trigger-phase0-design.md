# Jira label-based trigger — Phase 0 (both repos)

Status: approved for implementation planning
Scope: Phase 0 only, from `docs/future-enhancements.md`'s "Jira
label-based trigger (both repos) + split Jira (PM) / GitHub Issues
(research & dev)" entry. Phases 1-2 (GitHub Issues, dual-write,
dev-loop reading its work order from GitHub) are explicitly out of
scope for this change.

## Why

Today, `research-loop`'s and `dev-loop`'s polls are keyed on Jira epic
membership (`intakeEpics`/`readyEpic`, moved via `moveToEpic`, read via
a per-project `epicLinkField` that varies between team-managed and
company-managed Jira projects — `"parent"` vs. a `customfield_XXXXX`).
This is real onboarding cost for every new project
(`catalog-ui-management`, `catalog-ui-public` next) and produces board
ambiguity documented in both repos' `docs/config.md` ("still being
refined" and "refined, awaiting approval" look identical since both
share one epic).

Phase 0 replaces the epic-parent trigger with a Jira label trigger, in
both repos together — not research-loop alone. Without moving both,
once research-loop's approval step stops moving the epic, dev-loop's
existing trigger never fires again; there is no "later" for dev-loop's
side. Epics remain in Jira, untouched by any code, for board/PM
visibility only.

## Confirmed against real Jira before this design

Queried the real `fandango.atlassian.net` instance:
`labels in ("pipeline:research", "pipeline:dev", ...)` returns zero
issues, and every ticket currently in `TARS-1350` (intake epic) and
`TARS-1384` (ready epic) has an empty `labels` array. This is a fresh
rollout — no existing `pipeline:*` labels to reconcile, and Jira Cloud
labels are freeform (no separate "create the label" administrative
step). Backfilling `pipeline:research`/`pipeline:dev` onto in-flight
tickets so the new poll picks them up is the user's own responsibility
post-merge, not part of this implementation.

## Vocabulary

Two label fields, not one — they answer different questions and only
research-loop's runtime writes the second one:

- **`jira.triggerLabel`** — the label *this repo's own poll* matches
  on. research-loop: `"pipeline:research"`. dev-loop: `"pipeline:dev"`.
- **`jira.handoffLabel`** — the label a passing, human-approved (or
  `autoPromoteLabel`-gated) research-loop verdict swaps a ticket *to*,
  handing it to dev-loop. Both repos carry this field in their `Config`
  shape for symmetry (mirroring how dev-loop's config already carries
  `intakeEpics`/`pollJql.refine` today even though dev-loop's runtime
  never polls with it), but only research-loop's `loop-runner.ts`
  actually performs the swap in Phase 0. Value in both repos:
  `"pipeline:dev"`.

Both are plain strings (not arrays) — the label taxonomy is "mutually
exclusive, one at a time," unlike today's `intakeEpics: string[]`.

## Config shape changes (`src/types.ts`, both repos)

Delete from `Config.jira`: `intakeEpics`, `readyEpic`, `epicLinkField`.
Add: `triggerLabel: string`, `handoffLabel: string`. `claimStatus`,
`pollJql.{refine,dev}`, `statusNames` are unchanged in shape (their
*template contents* change — see below). dev-loop additionally keeps
`codeReviewFields` untouched (unrelated to this change).

Delete `JiraTicket.epic: string | null` from both repos'
`jira-client.ts` — confirmed via repo-wide grep that nothing reads
`.epic` beyond ticket construction (`RealJiraClient.pollOldestMatching`)
and one now-obsolete test assertion in each repo. Safe to remove
outright, not deprecate.

`src/config.ts`'s `PLACEHOLDER_PATHS` in both repos: remove the
`jira.readyEpic`/`jira.epicLinkField` entries (research-loop) /
`jira.readyEpic`/`jira.epicLinkField` entries (dev-loop), add
`jira.triggerLabel`/`jira.handoffLabel`.

## JQL changes (`src/jql.ts`, both repos)

Both repos' `pollJql.refine`/`pollJql.dev` templates swap their
placeholder from `{epics}`/`{epic}`/`{readyEpic}` to `{label}`.

**research-loop** (`buildRefineJql`/`buildDevJql` in `src/jql.ts`):
`buildRefineJql` fills `{label}` with `config.jira.triggerLabel`
(no more `.join(", ")` — single string now). `buildDevJql` (kept for
the same "research-loop owns the config shape dev-loop reads from"
symmetry/testability reason as today — research-loop never runs this
poll itself) fills `{label}` with `config.jira.handoffLabel`.

**dev-loop** (`buildRefineJql`/`buildDevJql` in `src/jql.ts`):
`buildRefineJql` (kept for the same test-symmetry reason as
research-loop's own unused-in-prod builder) fills `{label}` with
`triggerLabel`. `buildDevJql` fills `{label}` with `handoffLabel` and
**keeps its existing `{assignee}` placeholder and second function
argument unchanged** — the assignee clause exists because dev-loop has
no atomic claim step (see `docs/config.md`'s "Ticket status never
reverts"), which this change does not touch.

dev-loop's new dev-poll JQL becomes:

```
labels = "pipeline:dev" AND assignee = "{assignee}" ORDER BY created ASC
```

— dropping the old `status = "In Progress"` clause entirely (not kept
as a defensive belt-and-suspenders check). That clause encoded "which
epic-equivalent state, mechanically"; the label now signals pipeline
stage directly and unambiguously, so keeping status alongside it would
reintroduce exactly the kind of state redundancy the label swap is
meant to remove.

research-loop's new refine-poll JQL becomes:

```
labels = "pipeline:research" AND status = "To Do" ORDER BY created ASC
```

(status clause here is unrelated to the epic/label question — it
already exists to scope "not yet claimed," untouched.)

## The handoff itself (`src/loop-runner.ts`, research-loop only)

New `JiraClient` method (both repos' interface, replacing `moveToEpic`
— research-loop only ever called `moveToEpic` in this one place, so no
dual-purpose method to preserve):

```ts
swapLabel(ticketKey: string, from: string, to: string): Promise<void>;
```

`RealJiraClient.swapLabel` — single Jira `PUT /issue/{key}` using the
`update.labels` array-of-ops shape (`[{remove: from}, {add: to}]`),
not a GET-then-merge — Jira's labels field supports this directly.

research-loop's `runLoopIteration` (`src/loop-runner.ts:169-190`
today): on outcome `"landed"`, if `autoPromoteLabel` is present on the
ticket, call `swapLabel(ticket.key, config.jira.triggerLabel,
config.jira.handoffLabel)` in place of today's
`moveToEpic(ticket.key, config.jira.readyEpic)`. Identical gating rule,
same `autoPromoteLabel`-present check, same "no autoPromoteLabel ->
ticket sits in place" behavior — **not made automatic by default**, per
the entry's explicit instruction and per this repo's own
`src/loop-runner.ts:178` precedent. Bounced-outcome handling
(`transitionStatus(bounced)`) is completely unchanged — this proposal
does not touch bounce logic.

## dev-loop's `decideEpicMove` and `LoopKind` — deleted, not stubbed

dev-loop's `loop-runner.ts` has a `decideEpicMove(verdict, loopKind,
config)` function and a `LoopKind: "refine" | "dev"` type that exist
for test-symmetry with research-loop's own epic-move logic, but
dev-loop's `main.ts` only ever calls `runLoopIteration` with
`loopKind: "dev"` — the `"refine"` branch is exercised only by tests,
never in production. `decideEpicMove` returns `config.jira.readyEpic`
in its one live branch, a field being deleted, so it must change
regardless of this decision.

Since epic-move is retired system-wide (no loop moves an epic anymore,
by design — labels replace it), `decideEpicMove` is deleted outright,
along with its "returns an epic key" test assertions and the
`moveToEpic` call site in `runLoopIteration`. The `LoopKind` type and
the `loopKind === "refine"` branch inside `runLoopIteration` (which
today only decides which JQL builder to call) stay — that part is
still meaningful/tested (dev-loop's own poll always builds `buildDevJql`
in production, but the branch and its "a refine-loop landed verdict
does NOT transition to Code Review" test remain valid documentation of
intent independent of epics/labels).

## `JiraClient` interface diff (both repos)

Remove: `moveToEpic(ticketKey, epicKey)`.
Add: `swapLabel(ticketKey, from, to)`.
`StubJiraClient` gets a `swapLabel` that throws the same
`UNCONFIGURED_MESSAGE`-style error as its other methods, replacing its
`moveToEpic` stub.

## Docs to update

Every line below was confirmed via a fresh grep for `epic`/`Epic` in
each file at design time — not a general "update the shape bullets"
instruction. Each of `docs/config.md`'s ~6-8 epic-referencing
subsections per repo gets its own pass, not a single find/replace,
since several (e.g. dev-loop's incident writeup below) carry
irreplaceable historical content that must survive rephrasing.

**research-loop:**
- `docs/config.md` — the `jira.intakeEpics`/`readyEpic` shape bullet →
  `triggerLabel`/`handoffLabel`; the `jira.epicLinkField` bullet
  deleted entirely (no label-equivalent concept); the `{epics}`/`{epic}`
  JQL-placeholder bullet → `{label}`; "Ticket status never reverts"'s
  "**epic move**" paragraph and its "inside the ready epic" phrase →
  describe the label swap; Appendix A's "creating... the two pipeline
  epics... confirming `epicLinkField`" → describe confirming the two
  label strings instead; "Adding a new project" step 2 ("Fill in that
  project's own Jira epics...") → label strings instead of epics;
  delete the "Known tradeoff of the two-epic model" section outright
  (no longer applicable — a label swap makes "still being refined" vs.
  "refined, awaiting approval" distinguishable via label state itself,
  not just a comment).
- `README.md:29` — "Only after human review does a ticket move to the
  'ready' epic that dev-loop consumes" → describes the label swap.
- `.claude/skills/ticket-refine/SKILL.md` — Step 7's "the ticket stays
  in this same epic... the loop runner only moves it to dev-loop's epic
  if `autoPromoteLabel` is present" → rephrased to describe the label
  swap. No changes to comment *template content*
  (`Refined Spec — ready for ticket-to-pr`, bounce comment titles) —
  confirmed neither references epics.
- `pipeline.webtarsthree.config.json` — replace
  `intakeEpics`/`readyEpic`/`epicLinkField` with `triggerLabel:
  "pipeline:research"`, `handoffLabel: "pipeline:dev"`.
- `docs/future-enhancements.md` — trim the label-trigger entry to mark
  Phase 0 done (strike/remove its rollout bullet), keep Phases 1-2 and
  all "not yet scoped/deferred" notes intact (they still apply).
- `CHANGELOG.md` — new entry noting the label-trigger swap landed and
  epics are now board-only, untouched by any code.

**dev-loop:**
- `docs/config.md` — same shape-bullet updates as research-loop's
  (`intakeEpics`/`readyEpic`/`epicLinkField` bullets, `{epics}`/`{epic}`
  placeholder bullet); "Ticket status never reverts" section's
  references to the epic move and "inside the ready epic"; Appendix
  A's epic/`epicLinkField` confirmation step; "Adding a new project"
  step; delete "Known tradeoff of the two-epic model". Its own
  **"A landed dev-loop verdict never moves the epic" section is kept,
  not deleted** — it documents a real historical incident
  (TARS-1349's fix) whose underlying lesson (a landed dev-loop verdict
  moves status only, never any epic-or-label state) still holds after
  this change; only its epic-specific vocabulary
  (`decideEpicMove`/`readyEpic`/"Pipeline: dev-loop") gets updated to
  describe the same fact in label terms — the section heading and
  incident narrative stay.
- `docs/skills.md:98` — "the epic-move decision" → rephrased: dev-loop's
  `loop-runner.ts` no longer derives any epic-or-label-move decision
  from the verdict at all (`decideEpicMove` is deleted); this sentence
  should say the loop runner derives the real `RunLogLine` and nothing
  else from the verdict.
- `.claude/skills/ticket-to-pr/SKILL.md:164` — "this ticket should
  never have reached the Ready epic" → rephrased to reference the
  `pipeline:dev` label instead (real Phase 0 intake gating logic, not
  just prose).
- `pipeline.webtarsthree.config.json` — same field replacement as
  research-loop's.
- `CHANGELOG.md` — new entry, dev-loop's side of the same change.

## Test changes (both repos, TDD per CLAUDE.md)

Every test file the survey found referencing epic symbols gets RED
tests written first for the new label behavior, then updated/removed
for the old:

**research-loop**: `test/jql.test.ts` (rewrite epic-substitution
assertions as label-substitution), `test/loop-runner.test.ts` (rewrite
`moveToEpic` assertions as `swapLabel` assertions, across all outcome
branches: no-autoPromoteLabel, with-autoPromoteLabel, bounced,
ceiling-breach-after-landed, sync-error-surfacing), `test/config.test.ts`
(placeholder-path list), `test/jira-client.test.ts` (delete
`moveToEpic`'s two PUT-shape tests + placeholder-throw test; add
`swapLabel`'s equivalent PUT-shape test using the `update.labels` op
array + its own placeholder/error-path test if `triggerLabel`/
`handoffLabel` gets added to `PLACEHOLDER_PATHS`).

**dev-loop**: `test/jql.test.ts` (same label-substitution rewrite, plus
confirm the dropped `status = "In Progress"` clause is gone from the
expected dev-poll JQL and the `{assignee}` substitution still works),
`test/loop-runner.test.ts` (delete the two `decideEpicMove`-named
tests and all `moveToEpic`-not-called assertions sprinkled through
ceiling/bounce/landed-dev-loop test cases — those assertions
disappear along with the method, not get inverted to `swapLabel`, since
dev-loop's `loopKind: "dev"` path never called `moveToEpic` even
before this change), `test/config.test.ts`, `test/jira-client.test.ts`
(same `moveToEpic`→`swapLabel` PUT-shape swap as research-loop's).

`npm test` green before and after, in both repos, per CLAUDE.md.

## Out of scope (confirmed, not deferred-but-implied)

- Any status label (`pipeline:blocked`, `pipeline:pr-open`, etc.) —
  Phase 1+ per the entry's own phasing.
- GitHub Issues, the secret-redaction hook, dual-write — Phase 1.
- dev-loop reading its work order from GitHub — Phase 2.
- Backfilling the new labels onto real in-flight tickets in
  `TARS-1350`/`TARS-1384` — user's own responsibility post-merge.
- Any change to Jira comment *template content* — only descriptive
  prose in SKILL.md files changes, not what gets posted to Jira.
