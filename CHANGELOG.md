# Changelog

Notable fixes and behavior changes to the research-loop pipeline itself
(`src/`, `.claude/skills/ticket-refine/`, `.claude/agents/`). Newest
first. Not every commit needs an entry — only ones that change what the
loop is capable of or fix a failure mode a human had to diagnose.

## 2026-10-26 — Jira comment format unified: Context + Needs-decision bullets, both outcomes

`ticket-refine`'s Jira comments had drifted into two inconsistent shapes: a
passing verdict got one run-on paragraph, while a bounce got a fixed
`**Verdict:**`/`**Summary:**`/`**Needs from you:**` three-line header
followed by free-form prose. Neither was genuinely skimmable, and the two
outcomes didn't read as the same kind of comment.

**Fix**: both outcomes now write one Jira comment in the same shape — title,
then an optional `**Context:**` paragraph (0-3 sentences), then a
`**Needs decision:**` section (one bullet per distinct decision point; a
passing verdict omits this section entirely when `autoPromoteLabel` is
configured, since there's nothing to decide), then the
`[GitHub Issue](<url>)` link. "Ticket content protocol" items 2 and 3 in
`.claude/skills/ticket-refine/SKILL.md` define the shape; the "Bouncing"
section's step 2 now points at item 3 instead of duplicating it.
`docs/skills.md`'s own summary of the bounce shape was updated to match.
This changes only the Jira-facing comment body — the GitHub Issue's full
`### Overview`/`### Acceptance Criteria`/`### Scope` content, and the
comment title convention (`✅`/`❌ research-loop - <short context>`) that
re-pickup matches on, are unchanged.

## 2026-09-30 — A ticket that already landed is never re-refined

Symmetric to dev-loop's landed-ticket guard. If the `pipeline:research` ->
`pipeline:dev` label swap failed after a `landed` verdict (or a human left
the label in place), the ticket still matched the refine poll and could be
claimed and re-refined, costing a full Opus run and a duplicate `✅` spec.
The poll's `status = "To Do"` clause was only a partial guard.

**Fix**: `runLoopIteration` now checks `runs/<slug>.jsonl` (new
`hasLandedRun`) for every polled ticket *before* claiming it. A ticket with
a `landed` line is skipped -- no claim, no run, no cost -- and the poll
repeats with `AND key not in (...)` (new `excludeKeysFromJql`) so it cannot
block the queue. `main.ts` logs `<KEY>: skipped, already landed`.
`npm run reset-project` removes a ticket's runs lines, so a deliberate
re-refine after a reset still works.

Not covered: the guard keys on the `landed` run line only, not on an
existing `✅ research-loop` Jira comment, so a ticket whose runs line was
lost (e.g. a fresh clone) is not protected.

## 2026-09-29 — `ticket-refine` publishes the `✅` spec once, after the verifier passes; self-heal fixes merge into the draft

On TARS-1452 (GitHub Issue #454) the `## ✅ research-loop -` spec comment was
posted at 18:50Z, 30s *before* the Step 7 verifier was spawned
(`progress.jsonl`: `synthesize phase_end` "posted ... full refined ticket"
then `verify phase_start`). The verifier then found two false claims in the
spec's own evidence (AC5, AC11), and the two self-heal cycles were posted as
separate `## Self-heal cycle N` comments. `ticket-to-pr` reads only the
newest comment whose first line starts `## ✅ research-loop -`, so it would
have implemented the uncorrected AC5/AC11.

Root cause: the skill text contradicted itself. Step 6/7 said the `✅`
comment is written only after a passing verdict, but the definition-of-
ready checklist (item 0) and protocol item 6 made the verifier check the
*posted* Issue comment, which forces posting first. "Mechanics of a self-heal
cycle" never said where fixes go, so they were appended as delta comments.

**Fix**: Step 6 writes `RUN_DIR/draft-spec.md`; the verifier checks that
file; self-heal edits the file in place; the `✅` comment is published once
after a pass, verbatim from the draft. Self-heal is recorded only in
`progress.jsonl`. A re-pickup's `✅` comment carries a `Supersedes comments
<ids>` line. `verifier-agent` and the checklist gained an AC-shape rule
(behavior ACs one-per-test; structural/invariant ACs grouped into one
mechanical check; consider a split above ~10 behavior ACs).

## 2026-09-19 — edit-in-place comments made Jira/GitHub look out of sync on TARS-1450; `ticket-refine` now always posts a new comment

TARS-1450 bounced twice in one day, and each time the Jira comment and its
GitHub Issue mirror appeared to disagree about the ticket's state, even
though the pipeline itself was behaving correctly. Root cause: the
"idempotent re-refinement" convention (`SKILL.md`'s "Setup: idempotent
re-refinement") had the skill find its own prior research-loop-titled
comment on re-pickup/re-verify and **update that same comment in place**
on both Jira (`addCommentToJiraIssue` with an existing `commentId`) and
GitHub (`gh api ... -X PATCH` on the existing comment), rather than
posting a new one each cycle. Both Jira and GitHub render comment threads
in **creation-time order, not edit-time order** — so an edited comment's
content changes but its position in the thread never moves. Confirmed on
TARS-1450: Jira comment `1039214` / GitHub comment `5735844223` (created
2026-09-18T20:33, last edited 2026-09-19T02:08) sat at their original,
earlier position in both threads while a separate, later-*created* comment
(Jira `1039340` / GitHub `5737852103`, created 2026-09-19T00:30) landed
below them — a reader skimming top-to-bottom saw what looked like stale
content sitting above newer content, on both surfaces independently, even
though each surface's own data was internally self-consistent.

Confirmed dev-loop needed no fix on its comment-*writing* side —
`JiraClient.addComment`/`GitHubClient.addComment` and `loop-runner.ts` are
already create-only there, with no edit/PATCH path anywhere in that repo.

**Fix**: `ticket-refine`'s `SKILL.md` — "Setup: idempotent re-refinement"
now says the title-prefix match is for reading prior context only, never
an edit target; "Ticket content protocol" item 5 and the "Bouncing"
section's re-pickup line now say to always post a brand-new comment; and
an explicit prohibition was added against passing an existing `commentId`
to `addCommentToJiraIssue`, `gh api ... -X PATCH` on an existing GitHub
comment, and `gh issue comment --edit-last`. Added a new `PreToolUse` hook,
`.claude/hooks/block-comment-edit-in-place.sh` (backed by
`scripts/check-comment-edit-in-tool-input.ts`, wired into both the
Atlassian-MCP and Bash matchers in `.claude/settings.json`), as a
code-level backstop that denies any of those three call shapes outright —
same fail-closed pattern as the existing `block-secret-comments.sh` /
`block-github-secret-writes.sh` hooks, not a replacement for the prose
rule. dev-loop's `ticket-to-pr` `SKILL.md` (Phase 0 step 2) was updated
separately to read the **most-recently-created** matching comment, since a
ticket can now carry several matching comments over its life instead of
one collapsed/edited comment.

## 2026-09-18 — `reset-project --close-remote` hit a real `no-transition` case on TARS-1467; `closeTicket` now walks a bounded chain of intermediate hops

The live TARS-1467 handoff test (this repo refined it, auto-promoted to
`pipeline:dev`, dev-loop landed PR #436) closed cleanly end to end, but
`--close-remote` failed to close the Jira ticket itself: from Code
Review, this project's Story workflow offers no direct done-category
transition. `closeTicket` reported `no-transition` correctly (never
silently wrong), but the ticket needed a human to close it by hand — the
exact gap `--close-remote` exists to avoid.

A first fix added a single intermediate hop (Code Review → Development
Complete), but a live re-run showed the real workflow needed a *second*
hop too (Development Complete → Deployed to INT) before a done-category
transition appeared — a single hop wasn't enough for this Story's actual
gate count. `RealJiraClient.closeTicket` now walks up to
`MAX_INTERMEDIATE_HOPS` (4) intermediate statuses: at each step, if no
done-category transition is directly offered, it looks for a single
transition whose target name matches
`/complete|done|closed?|resolved?|ready|release|deploy|verified?
|approved?|accepted|delivered|shipped|merged/i` and does *not* match
`/block|reject|reopen|restart/i`. Exactly one such candidate → hop and
re-check; zero or more than one candidate at any step, or exhausting the
bound, → `no-transition`, never a guess. Deliberately generic across
issue types rather than configured per type — the live transitions list
at each step is already ground truth for what that specific ticket can
do next, so a Task's short workflow naturally needs 0-1 hops and a Story
gated behind several review/deploy steps just takes more of the same
logic. A successful close's `jiraDetail` names the full path taken (e.g.
`"Development Complete -> Deployed to INT -> Closed"`), so the exact
route is always visible, never silent. Ported directly from dev-loop's
identical fix.

Also fixed: `describeResetPlan`/`describeResetSummary` printed full
absolute paths (noisy in a real terminal); now shortened to `~/...` for
display only — the underlying `ResetPlan`/`ResetSummary` objects still
carry real absolute paths.

## 2026-09-17 — `reset-project` gains `--close-remote`, archives instead of deleting runs.jsonl lines, and reports a post-action summary

Closing out TARS-1465's real Jira ticket and mirror Issue after using it
as a live diagnostic ticket (from dev-loop's side) was done by hand.
Extended `reset-project` to do this deterministically for the next live
test (TARS-1467, an autonomous auto-promote handoff test), ported
directly from dev-loop's identical extension minus PR handling (this
repo never opens a PR):

- **`JiraClient.addComment`** (`src/jira-client.ts`): this repo's
  `JiraClient` interface never had one before -- the main loop posts
  Jira comments directly via the `ticket-refine` skill's own MCP tool
  call, not through this REST client. Needed so `--close-remote` (which
  runs outside any Claude Code session) can post a note before closing.
- **`JiraClient.closeTicket`**: finds a close transition by status
  *category* (`done`), not a hardcoded status name. Returns
  `already-done` / `closed` (names the transition used) /
  `no-transition` (never silently success).
- **`GitHubClient.closeIssue`** ported near-verbatim from dev-loop -- this
  repo's `GitHubClient` never had a close capability at all before (it
  only ever creates the mirror Issue).
- **New `src/remote-close.ts`**: `planRemoteClose`/`executeRemoteClose`,
  kept deliberately separate from `reset-project.ts` (mock-client DI vs.
  temp-filesystem tests). Closes the Jira ticket (posting a "test/reset
  ticket, not planned" comment first) and the mirror GitHub Issue
  (`not_planned`), each independently.
- **`reset-project.ts`**: removed `runs.jsonl` lines now archive to
  `runs/<slug>.reset-archive.jsonl` (append-only, never overwritten)
  before the live log is rewritten/deleted, instead of being lost.
  `executeReset` now returns a `ResetSummary`; `describeResetSummary`
  renders what actually happened, printed after a real run.
- **`reset-cli.ts`**: `--close-remote` (requires `--ticket`; refused for
  a whole-project reset). Real Jira/GitHub clients are constructed only
  when the flag is passed. New `reset-project:remote` npm script loads
  `.env`; the default `reset-project` script deliberately still does
  not. Agent policy (always confirm with the human before a real,
  non-dry-run `--close-remote` invocation) documented in `docs/reset.md`
  and `SKILL.md`.

## 2026-09-17 — added `npm run reset-project`: deterministic local-state wipe for re-running a ticket or project fresh

Diagnosing a real pipeline bug (from dev-loop's side, TARS-1465) meant
running a ticket through the pipeline live, several times. Cleaning up
the diagnostic history afterward -- `grep -v` against `runs.jsonl`,
`rm -rf` against `.pipeline/<slug>/runs/TARS-1465-*` -- is exactly the
kind of manual step that's easy to get wrong once (wrong ticket key in
the grep, an over-broad glob that catches a sibling ticket) and had no
test coverage of its own.

**Added**: `src/reset-project.ts` (`planReset`/`executeReset`/
`describeResetPlan`, fully unit-tested against a temp filesystem) plus
`src/reset-cli.ts` wiring it to `npm run reset-project -- --project=<name>
[--ticket=<KEY>] [--dry-run] [--yes]`. Ported directly from dev-loop's
identical module (same local-state layout, same scoping rules). Deletes
only this repo's own local, gitignored state (`runs/<project>.jsonl`
lines, `.pipeline/<project>/` run dirs and raw-usage files, matching
Ground-step worktrees under `targetRepo.path`) -- never Jira, GitHub, or
the target repo's git history, and never the `pipeline:research`/
`pipeline:dev` label. See `docs/reset.md` for the full scoping rationale
and `.claude/skills/reset-project/SKILL.md` for how to invoke it.

## 2026-09-17 — mirror GitHub Issue's body now links back to the Jira ticket

The initial body `createIssue()` writes at Issue-creation time
(`main.ts`, "Mirror of Jira ticket TARS-XXXX...") named the ticket as
plain text, not a link — a reader on the GitHub side had to already know
or guess the Jira base URL to find the actual ticket.

**Fix**: `${credentials.baseUrl}/browse/${ticket.key}` (the same
`JIRA_BASE_URL` this repo already uses for every Jira REST call) is now
formatted as a markdown link: `Mirror of [TARS-XXXX](.../browse/TARS-XXXX)`.
Backfilled onto TARS-1465's already-created Issue (#430 on
`fandango/webtarsthree`) via `gh issue edit`, since this body is only
ever written once at creation, never updated afterward.

## 2026-09-17 — secret-scan hook's "run as script" guard silently no-op'd through a symlink

`scripts/check-secret-in-tool-input.ts`'s guard for "am I being run
directly, not imported by tests" compared `import.meta.url` (symlink-
resolved by Node) against a raw `file://${process.argv[1]}` string (not
symlink-resolved). Reaching the script through a symlink made the
comparison silently false, skipped `main()` entirely, and exited 0 --
fail-*open*, since the hook reads that as "clean, allow" without ever
having read stdin. Confirmed live via the sibling `skills` repo's own
copy of this file, reached through `~/.claude/skills ->
.../Desktop/Repos/skills` (this repo's own directory isn't a symlink
today, so this was latent here, not yet triggered).

**Fix**: `isRunAsScript()` now compares `realpathSync()` of both sides.
Added an integration-style regression test (`test/check-secret-in-tool-
input.test.ts`) that spawns the real script through a fresh symlink and
asserts it still exits with the secret-found code -- the existing unit
tests call `decideExitCode()` directly and can't exercise this guard.

## 2026-09-17 — accept `--project=<name>` (equals-separated) alongside `--project <name>`

`parseArgs` in `src/main.ts` only recognized `--project`/`--config` in
space-separated form, which reads ambiguously next to a boolean flag:
`--stream --project webtarsthree` is three tokens with no visual grouping
for which value belongs to which flag. `--project=webtarsthree` doesn't
have that problem, so it's now the documented convention — the old
space-separated form still works, unchanged, no breaking change.

**Fix**: added `getArgValue()` (`src/main.ts`), checked before falling
back to the existing space-separated lookup.

## 2026-09-17 — secret-redaction false positive blocked Jira Epic-parent writes

`src/redact.ts`'s `SECRET_NAME_PATTERN` matched its bare `KEY` alternative
case-insensitively, so it caught ordinary lowercase JSON `"key"` fields
too — not just the intended uppercase `KEY=` env-var shape. Hit live
while creating a Jira issue with `parent: {"key": "TARS-1080"}` (required
on any TARS-project issue type that must be linked to an Epic):
`containsSecret()` flagged the payload, and the `block-secret-comments.sh`
PreToolUse hook denied the write outright.

**Fix**: split the bare-`KEY` check into its own case-sensitive,
uppercase-only match (`isSecretShapedName()` in `src/redact.ts`), leaving
the rest of `SECRET_NAME_PATTERN` case-insensitive as before.

## 2026-09-17 — simplify Jira/GitHub comment templates: drop @-mention, terser title, clean issue link

Per docs/future-enhancements.md's "Simplify Jira/GitHub comment
templates" entry (decided 2026-09-16, not yet coded until now). Three
changes to `.claude/skills/ticket-refine/SKILL.md`'s "Ticket content
protocol": (1) dropped the mandatory `jira.mentionAccountId` @-mention
from every Jira comment — confirmed excessive in practice
(TARS-1462); the config field itself stays, unused, for now. (2) Replaced
the fixed titles (`Refined Spec — ready for ticket-to-pr`,
`Ticket-Refine Bounce — <category>`) with `{✅|❌} research-loop - <short
context>`, both outcomes. (3) Replaced the `Full Overview / Acceptance
Criteria (N ACs) / Scope write-up: <raw URL>` pointer with a clean
`[GitHub Issue](<url>)` markdown link. Also updated the "Setup: idempotent
re-refinement" section's re-pickup match rule (it used to grep for the old
fixed strings) to match on the new leading-icon + `research-loop -`
prefix instead. No transition period — old-titled comments on in-flight
tickets are simply no longer matched by re-pickup; this only means a
ticket with an old-titled comment gets a *new* comment on its next pass
rather than an update-in-place, which is harmless.

## 2026-09-16 — `--project <name>` CLI flag; fix silent `--config` override

`src/main.ts` now requires `--project <name>` (resolved to
`pipeline.<name>.config.json` via `resolveProjectConfigPath()`/
`listAvailableProjects()` in `src/config.ts`), replacing the `loop` npm
script's hardcoded `--config pipeline.webtarsthree.config.json`. Fixes a
real bug: because `argv.indexOf("--config")` matched the *first*
occurrence, `npm run loop -- --config pipeline.catalog-ui-management.config.json`
silently kept using webtarsthree instead — there was no way to run a
second project via the npm script. `--config <path>` is kept as a
fallback for arbitrary paths; passing both flags is now an explicit
error rather than a silent pick. This unblocks running one loop per
project concurrently in separate terminals — each project's on-disk
state was already namespaced by `repoSlugFromUrl()`, the only thing
missing was correctly selecting which config each process loads. Does
**not** solve running two loop instances against the *same* project
concurrently — that's still the pre-existing, unsolved "Future: multiple
concurrent loop instances" gap noted in dev-loop's `docs/config.md`
(applies to this loop too; see `docs/future-enhancements.md`).

## 2026-09-16 — Jira label-based trigger, Phase 1: GitHub Issue mirror + content routing

Per `docs/future-enhancements.md`'s "Jira label-based trigger" entry,
Phase 1 ("research-loop creates/mirrors GitHub, dual-write") has landed.
Added `GitHubClient` (`src/github-client.ts`), mirroring `JiraClient`'s
injected-interface style, backed by the `gh` CLI. GitHub Issue creation
is wired into `main.ts`'s composition root right after claim — before
`ticket-refine` runs, not inside the skill's own Step 0/intake turn — so
every downstream skill run can assume the mirrored Issue already exists;
this also settles the doc's own "exact step" open question in favor of
the loop-runner, not the skill. Creation is idempotent (checks for an
existing Issue for the Jira key before creating one). Added
`.claude/hooks/block-github-secret-writes.sh`, a mandatory `PreToolUse`
launch-blocker on the new GitHub write surface — landed *before*
`SKILL.md`'s routing-rule rewrite below, per the doc's own prerequisite-
gate requirement, since GitHub carries real ticket/codebase content from
day one. Rewrote `SKILL.md`'s Jira/GitHub content-routing rule: Jira is
now narrowed to four content types (a blocking ambiguity needing a human
product decision, a scope call, an explicit confirmation request, or a
passing-verdict pointer), GitHub carries everything else (recon findings,
attack findings, verifier results, working/interpretation notes, bounce
evidence detail), and any comment that does reach Jira must now
@-mention the assignee (`Config.jira.mentionAccountId`) — a new
requirement with no prior convention. Cross-link between the two systems
is the plain URL in a comment on both sides the doc had already sketched.

## 2026-09-16 — jira.repoLabel: disambiguate repos that share one Jira project

When more than one target repo shares a single Jira project (e.g.,
`catalog-ui-management` and `catalog-ui-public` both file into project
`MC`), the stage label alone (`triggerLabel`/`handoffLabel`) can't tell
which repo a given ticket belongs to. Added `Config.jira.repoLabel` — an
always-paired second label naming the repo (e.g. `"repo:catalog-ui-management"`)
— ANDed into `pollJql.refine` (the only template this repo polls actively).
`buildRefineJql()` now substitutes both `{label}` and `{repoLabel}`
placeholders. A project with only one target repo (e.g. `webtarsthree`)
doesn't strictly need this for disambiguation, but every
`pipeline.<project>.config.json` sets it anyway for a uniform scheme
across projects, mirroring dev-loop's identical field (see dev-loop's
`CHANGELOG.md`, 2026-09-16).

## 2026-09-16 — Jira label-based trigger, Phase 0: epic-parent polling replaced with label polling

Per `docs/future-enhancements.md`'s "Jira label-based trigger" entry and
its Phase 0 design spec
(`docs/superpowers/specs/2026-09-15-jira-label-trigger-phase0-design.md`),
replaced the epic-parent trigger with a Jira label trigger, landed
together with the matching change in `dev-loop` (both repos must move
together — see the spec's "Why"). `Config.jira` drops
`intakeEpics`/`readyEpic`/`epicLinkField` in favor of two plain strings,
`triggerLabel` (`"pipeline:research"`) and `handoffLabel`
(`"pipeline:dev"`). `src/jql.ts`'s templates now substitute a single
`{label}` placeholder instead of `{epics}`/`{epic}`.
`JiraClient.moveToEpic` is replaced by `swapLabel(ticketKey, from, to)`,
implemented as one Jira `PUT` using the `update.labels` array-of-ops
shape — no GET-then-merge needed, since Jira's labels field supports this
directly. `loop-runner.ts`'s landed-verdict branch now calls `swapLabel`
in the exact same `autoPromoteLabel`-gated spot `moveToEpic` used to
occupy — unchanged manual-by-default behavior, just acting on a label
instead of an epic. Epics remain in Jira for board/PM visibility only,
untouched by any code from either repo.

## 2026-09-02 — Ported dev-loop's postRunDelaySec race fix; closed a missing-tool agent_error; raised maxRunsPerDay to 100

dev-loop raised its own `maxRunsPerDay` from 10 to 100 the day before
(see dev-loop's `CHANGELOG.md`, 2026-09-02), explicitly conditioned on
fixing what was actually burning through the old ceiling first ("100 is
the deliberate new floor going forward, not a temporary bump" — only
*after* the underlying `agent_error` cause was fixed). Checked whether
that same precondition held here before copying the number over, rather
than bumping it on faith:

1. **The `--add-dir`/Edit-Write bug dev-loop fixed doesn't apply.**
   `ticket-refine`'s `ALLOWED_TOOLS` has no `Edit`/`Write` at all — this
   skill is read-only against the target repo. Not a live risk here.
2. **But the identical *class* of bug was live**: `ALLOWED_TOOLS` in
   `src/main.ts` was missing `mcp__atlassian__search`,
   `mcp__atlassian__getConfluencePage`, and
   `mcp__atlassian__searchConfluenceUsingCql`. Confirmed via
   `.pipeline/webtarsthree/raw-usage/TARS-1391-2026-09-02T180226955Z.json`'s
   own `permission_denials` — TARS-1391's first pickup that day
   `agent_error`'d (no `verdict.json`, $0.44 spent) because it hit
   unapprovable prompts for exactly these tools and gave up; two other
   runs the same day (TARS-1392, TARS-1397) hit the same denial but
   happened to find a different path and still landed.
3. **The poll-loop race dev-loop fixed with `postRunDelaySec` was never
   ported here.** `src/main.ts`'s `for(;;)` loop re-polled immediately
   after a `"processed"` result, with no delay — same zero-delay shape
   dev-loop confirmed live caused a duplicate run to land within ~2s of
   a status transition, before Jira Cloud's search index caught up.
   research-loop hadn't hit this live yet, but the mechanism is
   identical (both repos share the same claim-then-poll composition-root
   pattern), so it was fixed preemptively rather than waiting for a real
   incident, same precedent as the 2026-08-27 `Read`/`Grep`/`Glob` entry
   below.
4. **dev-loop's bad-`Blocked`-transition fix does not port**: that fix
   gates the transition on `verdict.pr === null`, but `ticket-refine`'s
   bounced path has no `pr` concept at all (it never opens a PR) — no
   change needed here.

**Fix**: added `mcp__atlassian__search`, `mcp__atlassian__getConfluencePage`,
and `mcp__atlassian__searchConfluenceUsingCql` to `ALLOWED_TOOLS`
(`src/main.ts`). Added `src/poll-loop.ts` (`decideNextAction()`, mirroring
dev-loop's own module) plus a new `postRunDelaySec` field on
`pipeline.loop.config.json`/`LoopConfig` (`src/types.ts`) — a
`"processed"` result now sleeps for `postRunDelaySec` (5s) before the next
poll instead of looping straight back in; `main()`'s `for(;;)` loop now
delegates its post-iteration branch entirely to `decideNextAction()`
rather than an inline switch. `test/poll-loop.test.ts` covers all four
`LoopIterationAction` cases. Only after both fixes landed: raised
`pipeline.webtarsthree.config.json`'s `maxRunsPerDay` from 10 to 100,
matching dev-loop's new floor.

## 2026-09-01 — Redaction covered PII only, not secret-shaped env values

Ground's per-run worktree is deliberately nested inside the target repo's
own directory tree so `direnv` picks up its real local env (see "Target
repo (grounding)" in `SKILL.md`) — necessary for live dev-server calls, but
it also means real secrets are reachable from inside a run. `src/redact.ts`'s
`redactPII()` only ever stripped email addresses and the literal `$HOME`
path; it had no concept of a secret value, so an `env`/`printenv` dump or a
`cat .envrc` inside Ground/Attack's tool calls would pass through the
`log()`/`logError()` funnel in `src/main.ts` (terminal output, `--stream`'s
live tool_use/tool_result echo, and the `progress.jsonl` tail) completely
unredacted. Confirmed the mechanism is real via
`.pipeline/webtarsthree/runs/TARS-1381-20260819T063508Z/dev-server.log:1`
(`direnv: loading ~/Desktop/Repos/webtarsthree/.envrc`) — that same run's
own app logging at line 28 shows the safe pattern to imitate
(`hasClientSecret`/`clientSecretLength`, never the raw value). Separately,
`ticket-refine` and its subagents write Jira comments via MCP tool calls
that never pass through this repo's Node process at all, so no amount of
code-level redaction could cover that channel — it needed an explicit rule
the skill/agents follow, the same way the existing absolute-path-PII rule
already worked.

**Fix**: added `redactSecrets()`/`redactSensitive()` to `src/redact.ts` —
a known-env-value pass plus a name/value pattern pass (env-style
`NAME=value` and JSON `"name": "value"`, gated on a secret-shaped, case-
insensitive key name and a non-trivial value) plus AWS-key/JWT/embedded-
URL-credential format backstops. `src/main.ts`'s `log()`/`logError()` and
the `verdictRaw` read in `runSkill` now go through `redactSensitive()`
instead of `redactPII()` directly. Extended the Ticket content protocol in
`SKILL.md` (new item 6) and the Definition-of-ready checklist (new item 7,
mirrored into `verifier-agent.md` and `docs/skills.md`) to bar raw secret
values from any Jira comment, `progress.jsonl` note, or the result line —
presence/shape only. Added the same "never report a raw value" line to
`recon-agent.md`'s and `devils-advocate-agent.md`'s "What NOT to do"
sections. A companion fix went into `dev-loop` in parallel (same
`redact.ts`/`main.ts` pattern; its outward channel is the PR title/body via
`push-branch` rather than a Jira comment).

**Adversarial review caught two real bugs in the first version of this
fix** before it shipped: the value-capture regex used `[^\s",}]+`, which
(a) stopped at the first comma inside a value, corrupting JSON when
`verdictRaw` (fed straight to `JSON.parse()` in `parseVerdict()`) contained
a comma-bearing secret — confirmed via `JSON.parse()` throwing on
`{"apiKey":"secret,value"}` → `{"apiKey":REDACTED_SECRET,value"}` — and (b)
its trailing optional quote consumed a following nested object's opening
`{`, permanently desyncing the regex and silently skipping every secret
inside that nested object. Fixed by splitting each shape into an explicit
quoted variant (requires a real, escape-aware closing quote) and an
unquoted variant (excludes `{`/`[`/quotes so it can never cross into a
following value), rather than one regex trying to handle both with an
optional quote. 8 regression tests added in `test/redact.test.ts` for these
two cases plus the escaped-quote and multi-secret-per-line cases that
exercise the same code path.

**Residual gaps as of the fix above** (name/value pattern matching is
inherently best-effort, and this round-1 fix reduces risk — it does not
close it): a PEM/SSH private-key block has no `NAME=value` shape to match;
a bare secret value with zero adjacent key name or URL context (e.g. an
agent pasting just the value with no surrounding text) can't be recognized
as secret-shaped at all. Revisit if either is observed leaking in a real
run. (Round 2, below, closes the "instruction-only" gap on the Jira-
comment channel itself and narrows — but doesn't eliminate — the bare-
value case; see its own residual-gaps note.)

**Round 2 — real enforcement on the Jira-comment channel, plus
hardening.** Adversarial review of the round-1 fix above (3 parallel
agents: logic/correctness, runtime-risk, security) found the fix itself
had two real bugs and one architectural gap, and a follow-up adversarial
review of *this round's own plan* (same 3-agent structure) found several
more design gaps before anything shipped — every finding below was
addressed, including ones rated only "minor," per an explicit "do a solid
pass now, not later" call.

`src/redact.ts` hardening: broadened `SECRET_NAME_PATTERN` to add
`SIGNING_KEY`/`ACCOUNT_KEY`/`ROLE_KEY`/`ENCRYPTION_KEY`/a standalone `KEY`
name/`DSN`/`CONNECTION_STRING`/`DATABASE_URL`/`URI`/`COOKIE`/`SESSION` —
deliberately *not* a bare unanchored `KEY` substring match, since an
earlier draft of this pattern matched `issueIdOrKey` (present on nearly
every Jira MCP call) and would have made the new hook below deny every
legitimate Jira write; caught by the hook's own end-to-end test failing.
The existing `ENV_UNQUOTED_PATTERN` now also excludes `;`, which — as a
side effect of the same character-class change — makes it match one
`Key=value` segment at a time inside a semicolon-delimited connection
string (`Server=x;Password=y;Timeout=z`), so any segment whose key matches
`SECRET_NAME_PATTERN` is caught (`AccountKey=`, `SharedAccessSignature=`,
etc.), not just a hand-picked `Password=`/`Pwd=`. Added three new bare-
token format backstops (Stripe `sk_live_`/`rk_live_`/`pk_live_`, GitHub
`gh[oprsu]_`, Slack `xox[baprs]-`), the same confidence bar as the existing
AWS-key/JWT backstops — these target the single most likely real leak
shape a NAME=value pattern can't catch: a bare value pasted in prose with
no key name nearby (e.g. "...using key sk_live_51H8x... which is
hardcoded..."). Fixed the known-env-value pass's doc comment, which had
overstated its own coverage — it only ever helps for secrets *this Node
process itself* inherited, never a target repo's own secrets loaded via
`direnv` in a child Bash session; the name/format pattern pass is the real
defense for that case, and now says so. Added `containsSecret(text):
boolean`, a boolean check reusing `redactSecrets()`'s own patterns (one
source of truth, not a second implementation) — this is what the new hook
below runs.

Fixed a real bug the truncate-ordering fix's own repro caught: fixing
`SECRET_NAME_PATTERN` initially broke `DATABASE_URL=postgres://user:pass@
host/db` handling — with `DATABASE_URL`/`URI` now secret-shaped names, the
generic NAME=value pass started swallowing the *whole* URL value before
the existing, more precise `URL_CREDENTIAL_PATTERN` (which redacts only
the embedded `user:pass@` segment and keeps the host/port/path) got a
chance to run. Fixed by skipping URL-shaped values in the generic pass
entirely, so `URL_CREDENTIAL_PATTERN` is unambiguously the pass that
handles them. Caught by two now-passing regression tests
(`test/redact.test.ts`) that predate this round and would otherwise have
silently regressed.

`src/main.ts`: fixed a truncate-before-redact ordering bug in
`printStreamEvent()` — `--stream`'s tool_use/tool_result echo truncated
output to 200 characters *before* calling `redactSensitive()`, so a secret
cut mid-value by truncation lost its closing quote and the (now unquoted)
prefix printed in the clear. Confirmed via repro: a Stripe-shaped fake key
straddling the 200-char boundary printed ~20 characters of itself
unredacted under the old order, zero under the fixed order. Fixed by
redacting the full value first, inside `truncate()` itself, then
truncating the already-redacted result.

**New: a real code-level backstop on the Jira/Confluence-write channel,
not just the prose instruction.** Added a Claude Code `PreToolUse` hook
(`.claude/hooks/block-secret-comments.sh` + `.claude/settings.json`) that
intercepts every Atlassian MCP write call this pipeline's `ALLOWED_TOOLS`
can reach today (`addCommentToJiraIssue`, `editJiraIssue`) plus the wider
realistic surface a future `ALLOWED_TOOLS` change could reach without
anyone remembering to update this hook (`addWorklogToJiraIssue`,
`createIssueLink`, `createJiraIssue`, the four Confluence page/comment
write tools) — scans the whole `tool_input` via a new checker script
(`scripts/check-secret-in-tool-input.ts`, calling `containsSecret()`) and
denies (exit 2) any write containing a secret-shaped value before it ever
reaches the real API. Confirmed via Claude Code's own worktree docs that
this actually applies to the real pipeline path, not just an isolated
test: `$CLAUDE_PROJECT_DIR` is fixed at CLI-launch time to research-loop's
own directory (where `main.ts` spawns the `claude -p` child with no `cwd`
override) and does not follow the worktree the child later creates inside
the *target* repo.

Two hardening decisions worth recording since they weren't obvious from
the first sketch: (1) the checker reads the untrusted `tool_input` JSON
from **stdin only** — never interpolated into a dynamically-built source
string or passed as a command-line argument — because comment/ticket
content is adversarially-influenceable per this pipeline's own threat
model, and either alternative would have let content containing
backticks/`${}`/quotes break out into code execution, or leak into
`ps`/`/proc` process listings on a shared host. Verified via a dedicated
test case (a comment body containing exactly those characters) that the
checker only ever treats such content as data. (2) The hook fails
**closed**: if the checker can't run at all or crashes, that denies the
write (mapped to the same `exit 2` as "secret found," but with a
distinguishable stderr reason) rather than allowing an unverified write
through. Bounded by `ticket-refine`'s own self-heal cap (4 cycles per run,
`SKILL.md` Step 7), so a persistently broken hook can't loop a run
forever. Deliberately chose non-colliding internal exit codes (checker
process exit 3 = secret found, exit 2 = check failed) rather than reusing
Node's own default crash exit code (1) for "secret found" — a completely
broken checker crashing before any of its own error handling can even run
would otherwise be indistinguishable from one that correctly found a real
secret, misleading whoever reads the denial reason. Caught by the hook's
own end-to-end test (`test/hooks/block-secret-comments.test.mjs`)
simulating exactly this crash.

**Residual gaps, round 2** (same "risk-reduction, not closed" framing as
round 1 — this round narrows what round 1 left open, it doesn't eliminate
it): the hook is a name/format-anchored heuristic, not a semantic secret
detector — a bare value pasted in prose with no `NAME=` prefix and not
shaped like one of the three new recognized bare-token formats still gets
through, as does a secret deliberately or accidentally split across two
separate comment/edit calls (each call is scanned independently). PEM/SSH
key blocks remain unaddressed, as in round 1. A fully general
high-entropy-string detector remains explicitly out of scope — real
false-positive cost, not a cheap addition like the formats added this
round.

## 2026-08-27 — Formalized in-run self-heal vs. bounce in ticket-refine's Step 7

On a real `TARS-1284` run, Verify found 4 distinct defects in its own
synthesized spec (a mocked dependency missing a default resolved value
that would crash the first test on contact, an unreachable AC
assertion, an implicit value the code actually branches on, a vacuous
AC) and fixed all 4 in place across re-verify cycles, without ever
bouncing to a human. That behavior was correct but undocumented — Step
7 as written only described two outcomes, pass or bounce — so nothing
guaranteed a future run would draw the same line between "fix it myself"
and "this needs the human gate."

Added `#### Self-heal vs. bounce` to Step 7: a Verify failure is now
explicitly classified as **mechanical** (one derivable correct fix from
evidence already gathered this run — no tradeoff, no new investigation)
or **judgment-requiring** (a real design call, per the skill's own
"for the human gate, not a machine guess" principle — bounce as normal,
spend no retries on it). Mechanical failures self-heal and re-verify,
capped at 4 cycles per run; exceeding the cap without resolving is
itself evidence to bounce `spec_ambiguous` with all attempts attached.
Each self-heal cycle gets a distinct `progress.jsonl` line
(`"self-heal cycle <n>: ..."`) so a run that iterated internally is
distinguishable from one that passed clean, and the finalized comment /
`verdict.json` note the cycle count.

Moved from `docs/future-enhancements.md` (where this was logged as an
idea) — see that file's still-open cheap-tier-gate idea for the other
half of what came out of watching that run.

## 2026-08-27 — Headless runs could stall forever on a Read permission prompt

`ALLOWED_TOOLS` in `src/main.ts` allowed `Bash` plus the specific
Atlassian MCP calls this skill uses, but never `Read`, `Grep`, or
`Glob`. `--permission-mode acceptEdits` only auto-approves `Edit`/
`Write`, not reads — and `Edit` itself refuses to touch a file that
hasn't been `Read` in-session first. So the moment `recon-agent` or
`ticket-refine`'s synthesis phase tried to edit a file it hadn't
already `cat`'d via `Bash`, it fell back to `Read`, hit an unanswerable
permission prompt (no human in a headless `-p` run), retried, and gave
up without ever writing `verdict.json`.

Not yet observed live in this repo, but confirmed as the same
mechanism that produced dev-loop's `agent_error` runs on TARS-1341,
TARS-1367, and TARS-1364 (see dev-loop's own `CHANGELOG.md`) — fixed
here preemptively for consistency, since both repos share this
composition-root pattern.

**Fix**: added `Read`, `Grep`, `Glob` to `ALLOWED_TOOLS` (`src/main.ts`).
