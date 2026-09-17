# Changelog

Notable fixes and behavior changes to the dev-loop pipeline itself
(`src/`, `.claude/skills/ticket-to-pr/`, `.claude/agents/qa-agent.md`).
Newest first. Not every commit needs an entry — only ones that change
what the loop is capable of or fix a failure mode a human had to
diagnose.

## 2026-09-17 — secret-redaction false positive could deny Jira-shaped payloads

`src/redact.ts`'s `SECRET_NAME_PATTERN` matched its bare `KEY` alternative
case-insensitively, so it caught ordinary lowercase JSON `"key"` fields
too — not just the intended uppercase `KEY=` env-var shape. Confirmed via
`{"parent":{"key":"TARS-1080"}}` (Jira's Epic-parent shape) being flagged
by `containsSecret()`. Not yet observed live in this repo (this repo's
own `PreToolUse` hook only scans `gh issue`/`gh pr` Bash command text, not
arbitrary JSON), but this module deliberately mirrors research-loop's
`src/redact.ts`, where the same bug did block a real Jira issue create —
fixed here too for consistency, same as research-loop's own 2026-08-27
`Read`/`Grep`/`Glob` fix crossed the other direction.

**Fix**: split the bare-`KEY` check into its own case-sensitive,
uppercase-only match (`isSecretShapedName()` in `src/redact.ts`), leaving
the rest of `SECRET_NAME_PATTERN` case-insensitive as before.

## 2026-09-17 — adopt the {icon} <repo> - <context> comment convention for the Jira bounce comment

buildBounceCommentAdf's bold first line changes from `Bounced
(<failure_category>):` to `❌ dev-loop - <failure_category>:`, matching
research-loop's own new comment-title convention (see that repo's
CHANGELOG.md, same date) rather than inventing a different template for
this repo's own GitHub write (Task 5, this session) to follow later.
Also updated ticket-to-pr/SKILL.md's Phase 0 intake step, which used to
look for research-loop's now-retired `Refined Spec — ready for
ticket-to-pr` exact title -- it now matches on the `✅ research-loop -`
prefix instead.

## 2026-09-17 — startup-time merge-reconciliation pass, closes the mirror Issue on merge

Nothing in this pipeline reacted to a GitHub PR merge event -- GitHub's
own "Closes #N" auto-close only fires while dev-loop happens to be
running at merge time. Added `reconcileMergedTickets`
(`src/reconcile.ts`), run once per poll cycle before `runLoopIteration`:
finds every ticket at Code Review via a new `JiraClient.pollAllMatching`
query, resolves its PR URL from `runs.jsonl`'s own history, checks
`gh pr view --json state,mergedAt`, and closes the mirror GitHub Issue on
a confirmed merge. Deliberately does not touch the Jira ticket itself --
narrower than the original Jira-label-trigger design's full
`pipeline:dev`→`pipeline:merged` swap, since the label scheme that
depended on (`stageLabels`/`pipeline:pr-open`) was never built. See
research-loop's `docs/future-enhancements.md` for the full history.

## 2026-09-17 — fix bounce-loop bug: exclude bounced-status tickets from pollJql.dev

A bounced dev-loop ticket (status transitioned to `statusNames.bounced`,
e.g. "Blocked") kept matching `pollJql.dev` on every subsequent poll cycle
— nothing in the JQL's match criteria changed on a bounce, since
`pipeline:dev`'s label-based design was never meant to also encode
bounced-vs-not. Confirmed live on TARS-1462: 5 near-identical bounces in
~14 minutes (~$2.3) before the process was killed by hand; left unfixed,
every future dev-loop bounce would repeat this until `maxRunsPerDay`
trips (a ~$46 ceiling at this ticket's observed cost-per-run) or a human
intervenes. Fixed by adding `AND status != "{bouncedStatus}"` to every
project's `pollJql.dev` template, filled from the already-configured
`jira.statusNames.bounced` — no new config field, no label change. See
research-loop's `docs/future-enhancements.md`'s "dev-loop bounce-loop
bug" entry for the full tradeoff analysis this resolves (chose JQL
status-exclusion over `swapLabel()`-on-bounce, since the label-strip
alternative left "what does the label become instead" unscoped).

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
concurrent loop instances" gap noted in `docs/config.md`.

## 2026-09-16 — `jira.repoLabel`: disambiguate repos that share one Jira project

Added `Config.jira.repoLabel` (required, plain string, e.g.
`"repo:catalog-ui-management"`) and a `{repoLabel}` placeholder in both
`pollJql.refine`/`pollJql.dev` templates, ANDed alongside the existing
`{label}` substitution. `src/jql.ts`'s `buildRefineJql`/`buildDevJql` both
fill it in; `src/config.ts`'s `findPlaceholders` checks it for a leftover
`"___"` same as every other Jira-wiring field.

**Why**: `catalog-ui-management` and `catalog-ui-public` both file tickets
into the same Jira project (`MC`) — the stage label alone
(`triggerLabel`/`handoffLabel`) can't tell which of the two repos a given
`pipeline:dev`-labeled MC ticket actually belongs to, so whichever
dev-loop instance happened to poll first could claim the wrong repo's
ticket. `repoLabel` never changes across a ticket's lifecycle (unlike the
stage label, which swaps); every `pipeline.<project>.config.json` sets it,
including single-repo projects like `webtarsthree`, for a uniform scheme.
Does **not** solve running two loop instances against the *same*
repo/project pair concurrently — that's still the pre-existing, unsolved
"Future: multiple concurrent loop instances" gap noted in `docs/config.md`.

## 2026-09-16 — Jira label-based trigger, Phase 0: epic-parent polling replaced with label polling

Per research-loop's `docs/future-enhancements.md` "Jira label-based
trigger" entry and its Phase 0 design spec (see research-loop's
`docs/superpowers/specs/2026-09-15-jira-label-trigger-phase0-design.md`),
replaced the epic-parent trigger with a Jira label trigger, landed
together with the matching change in `research-loop` (both repos must
move together — see the spec's "Why"; without this, research-loop's
approval step no longer moves an epic, and this repo's old trigger would
never fire again). `Config.jira` drops `intakeEpics`/`readyEpic`/
`epicLinkField` in favor of two plain strings, `triggerLabel`
(`"pipeline:dev"`) and `handoffLabel` (also `"pipeline:dev"`, carried for
shape symmetry only). `src/jql.ts`'s dev-poll template now substitutes
`{label}` in place of `{readyEpic}`, keeps its existing `{assignee}`
placeholder and second function argument unchanged, and drops the
`status = "In Progress"` clause entirely — the label now signals pipeline
stage directly, so keeping status alongside it would reintroduce the same
state redundancy the label swap removes. `JiraClient.moveToEpic` is
replaced by `swapLabel(ticketKey, from, to)`. `decideEpicMove` and its
`readyEpic`-returning branch are deleted outright (not stubbed) — this
repo's `loopKind: "dev"` path never called `moveToEpic` in production
anyway, so this removes a dead-in-production code path, not a behavior
change; `LoopKind` and the `loopKind === "refine"` branch (which only
decides which JQL builder to call) are unchanged. Epics remain in Jira for
board/PM visibility only, untouched by any code from either repo.

## 2026-09-14 — A bounced ticket went Blocked with no trace anywhere in Jira of why

`ticket-to-pr` has no Jira-write tool (by design — see the 2026-09-01
entry below on why this pipeline keeps its write surface narrow); a
genuine bounce's only output was `verdict.detail`, read by
`runLoopIteration` (`src/loop-runner.ts`) and appended to the local
`runs/<project>.jsonl` audit log before transitioning the ticket to
`Blocked`. The evidence never reached the ticket itself. Surfaced when
TARS-1441 (bounced at Red, `spec_ambiguous`: two ACs' tests trivially
passed against unmodified baseline code, so RED couldn't be confirmed)
and TARS-1438 (bounced at Plan, `spec_ambiguous`: an AC pointed at an
`App.test.jsx` testing pattern that doesn't exist in that file) both
sat in Blocked with nothing on the ticket explaining why — a human had
to go read this repo's local `runs.jsonl` to find out.

**Fix**: added `JiraClient.addComment(ticketKey, bodyAdf)`
(`src/jira-client.ts`; `RealJiraClient` POSTs to
`/rest/api/3/issue/:key/comment`, `StubJiraClient` throws
not-configured like every other method). `runLoopIteration` now calls
it via the new `buildBounceCommentAdf()` immediately before the
existing Blocked transition, whenever a bounce is genuine
(`verdict.pr === null` — the same condition that already gates the
transition itself). The comment-post has its own try/catch, separate
from the transition: a failed comment must never block the Blocked
transition (that would leave the ticket silently stuck In Progress
over a comment failure alone), so both failure modes independently
merge into `jiraSyncError` instead.

## 2026-09-03 — Commits and PR titles never carried a conventional-commit type, so every merge fell through to a patch bump

`SKILL.md`'s Phase 3 Green commit was hardcoded to `feat(<TICKET>): ...`
regardless of ticket type, and Phase 5's PR title had no type prefix at
all (`<TICKET>: <ticket summary>`). The target repo's CI
(`semantic-version-calculate`) computes its semver bump from the
squash-merge commit message on `master`, and GitHub uses the PR title as
that message — so a real feature ticket landed as a patch bump instead of
minor, and any breaking change would never have been flagged as major
either, since neither commit nor PR title ever expressed ticket type.

**Fix**: Phase 0 now fetches the ticket's `issuetype` and derives a
`COMMIT_TYPE` from it (`Bug` → `fix`, everything else → `feat`) — a direct
field mapping, not an inference. Phase 3's Green commit and Phase 5's PR
title both now use `<COMMIT_TYPE>(<TICKET>): ...`. A breaking-change
marker is only added if the Refined Spec comment itself states the
change is breaking — never inferred from scope.

## 2026-09-02 — Verify phase ran a 4th qa-agent check before bouncing, tripping runTimeoutMin

`SKILL.md` Phase 4 step 4's wording ("If after 3 verify loops issues
persist, bounce") was ambiguous between "after the 3rd `qa-agent` check"
and "after 3 fix cycles, run a confirmation check." Confirmed live on
TARS-1399: a first run correctly bounced right after its 3rd `qa-agent`
invocation reported `fail` (46 min total). A second run instead fixed the
3rd loop's finding and then spawned a *4th* `qa-agent` invocation to
re-check before bouncing — an unbudgeted extra loop that pushed the run to
87 minutes and tripped `ceilings.ts`'s `runTimeoutMin` (45 min), pausing
the poll loop (`process.exit(1)` in `main.ts`) after the run had already
completed. Both bounces were themselves legitimate — `qa-agent` found a
genuinely new stale-async-state defect each time — this was a budget-
counting bug, not a false-positive verify gate.

**Fix**: reworded Phase 4 step 4 to make the budget explicit — each
`qa-agent` invocation is one verify loop, and the 3rd invocation is the
last one a run gets; a `fail` on that 3rd check bounces immediately, with
no further fix-and-re-check cycle.

## 2026-09-02 — Immediate re-poll raced Jira's index and could clobber a just-set status; Jira QA Notes were a useless two-line stub

Diagnosing why TARS-1389 sat in `Blocked` despite a landed, mergeable PR
(#400) turned up two related bugs plus a separately-flagged content gap:

1. **Race**: `src/main.ts`'s `for(;;)` poll loop re-polled immediately
   after a `"ran"` result, with no delay — only `"idle"` ever slept.
   Jira Cloud's search index lags slightly behind a write, so the very
   next poll could still match a ticket whose status was *just*
   transitioned. Confirmed live: a duplicate `ticket-to-pr` run landed on
   TARS-1389, TARS-1390, and TARS-1393 within ~2s of each one landing.
2. **Bad `Blocked` transition**: `src/loop-runner.ts` transitioned *any*
   `bounced` verdict to `statusNames.bounced` ("Blocked") unconditionally.
   For TARS-1389, the race above produced a second run whose verdict
   correctly bounced with "PR already open, nothing to do" — a benign
   no-op, not a real blocker — but the unconditional transition still
   stomped the ticket's just-set `Code Review` status back to `Blocked`.
   TARS-1390/1393 avoided this only because their redundant runs happened
   to crash before writing a valid `verdict.json` (`agent_error`, which
   never touches Jira status).
3. **Useless QA Notes**: every landed ticket's Jira `customfield_14226`
   ("QA Notes") field ended up as a two-line stub (`PR: <url>` / `Verify
   loops: N`), because `buildQaNotesAdf()` could only build from fields
   already on `Verdict`. Not the same content as the PR body's own
   `## QA Notes` section (a terse pass/fail summary, left unchanged) — this
   field is meant for a human QA reviewer's actual manual-testing steps.

**Fix**: `src/poll-loop.ts` (new) centralizes what the poll loop does after
each result kind; a `"ran"` result now sleeps for the new
`pipeline.loop.config.json`'s `postRunDelaySec` (5s) instead of looping
straight into another poll. `loop-runner.ts` now only transitions a
bounced verdict to `Blocked` when `verdict.pr === null` — a genuine
blocker never reaches Phase 5 (PR) and so never has `pr` set, which
distinguishes it from the "already landed, nothing to do" case without an
extra Jira read. `Verdict` gained an optional `qa_notes: string[]` field;
`ticket-to-pr` (SKILL.md Phase 4) now writes real sequential manual-testing
steps into it from the ticket's own Acceptance Criteria, and
`buildQaNotesAdf()` renders those as a bold "Manual testing steps:" header
+ ordered list (falling back to the old stub when absent/empty) —
matching the ADF shape the retired interactive `qa-notes`/`push-branch`
skills built by hand.

## 2026-09-02 — Spawned claude session had no directory grant for the target repo worktree, every Edit/Write denied

When `targetRepo.path` is set, `ticket-to-pr`'s per-run worktrees are
created inside that checkout, not inside dev-loop's own directory tree
(see `docs/logging.md`). `src/main.ts` spawned `claude -p` with
`--permission-mode acceptEdits` but no `--add-dir`, on the (wrong)
assumption that `acceptEdits` alone was enough. `acceptEdits` only
auto-answers the Edit/Write permission *prompt* — it does not grant tool
access to a directory outside the process's cwd. Confirmed live on
TARS-1393: every `Edit` call into the worktree was denied ("you haven't
g[ranted]..."), the skill never reached a commit, no `verdict.json` was
ever written, and the run logged `agent_error`. TARS-1389 and TARS-1390
hit the same failure repeatedly (10+ `agent_error` runs each), leaving
enough stale incomplete run dirs that a later run correctly detected
"concurrent run in progress" and bounced with `blocked` — the tickets
themselves were fine; the loop's own tooling never got far enough to do
real work.

**Fix**: added `targetRepoAddDir()` to `src/config.ts` (returns
`config.targetRepo.path`, or `null` when unset — the clone-based flow's
worktrees already live under `.pipeline/<slug>/repo`, inside dev-loop's
own cwd, so no extra grant is needed there). `src/main.ts` now passes
`--add-dir <path>` in `claudeArgs` whenever it's non-null.

## 2026-09-01 — Redaction covered PII, not secrets, despite real credentials being reachable from every run

Ground/Red/Green/Verify run inside a per-run git worktree nested inside
the target repo's own directory tree — specifically so direnv picks up
the target repo's real local `.envrc`/`.env` (see `SKILL.md`'s "Target
repo" section). That's intentional and correct, but it also means real
secrets are reachable from inside a run. `src/redact.ts`'s `redactPII()`
only stripped email addresses and the literal `$HOME` path — it had no
concept of a secret value. Every line this process prints goes through
it via `log()`/`logError()` in `src/main.ts` (terminal output,
`--stream`'s live `tool_use`/`tool_result` echo, and the
`progress.jsonl` tail), so an `env`/`printenv` dump or a `cat .envrc`
from inside a Bash tool call would have passed through completely
unredacted.

**Fix**: added `redactSecrets()` and a `redactSensitive()` funnel
(`redactSecrets(redactPII(text))`) to `src/redact.ts` — a known-value
pass over `process.env` for secret-shaped variable names, plus a name/
value pattern pass for `NAME=value`/`export NAME=value` and JSON
`"name": "value"` shapes, plus AWS-key and JWT format backstops
regardless of variable name. `log()`/`logError()` in `src/main.ts` now
call `redactSensitive()` instead of `redactPII()`, and `verdict.detail`
(a skill's own self-report, which could in principle echo back
something it saw in Ground/Red/Green) is redacted before it flows into
the `runs.jsonl` log line. Also extended `SKILL.md`'s existing
no-absolute-paths rule to bar raw env var values, `.envrc`/`.env`
content, and credential/token/key/password values from the PR title or
body (presence/shape only), and added the same rule to
`qa-agent.md`'s "What NOT to do" section.

A companion fix for the identical gap (both repos share the same
composition-root pattern) landed in `research-loop` the same day.

### Follow-up the same day — the name/value patterns above corrupted JSON and silently skipped keys

Adversarial review of the fix above found two bugs in
`ENV_NAME_VALUE_PATTERN`/`JSON_NAME_VALUE_PATTERN`, confirmed by direct
execution rather than just theoretical: the optional trailing quote made
the value's end ambiguous. For a quoted value it stopped at the first
comma inside the value (`{"apiKey":"secret,value"}` became
`{"apiKey":REDACTED_SECRET,value"}` — invalid JSON). For an unquoted value
it could consume a following nested object's opening `{`, permanently
desyncing the regex's `lastIndex` and silently skipping every key after
it (a `clientSecret` nested one level deep was never redacted at all).

**Fix**: replaced each ambiguous pattern with an explicit quoted/unquoted
pair (`ENV_QUOTED_PATTERN`/`ENV_UNQUOTED_PATTERN`,
`JSON_QUOTED_PATTERN`/`JSON_UNQUOTED_PATTERN`) — quoted variants are
escape-aware (`(?:[^"\\]|\\.)*`) so an escaped `\"` doesn't terminate the
value early, unquoted variants exclude `{`, `[`, and `"` so they can never
wander into a following value's delimiter, and quoted patterns run first
so an already-redacted `"REDACTED_SECRET"` can't be re-matched by an
unquoted pattern. The env-style unquoted pattern deliberately does *not*
exclude comma (shell `NAME=value` has no comma-delimiter convention, so
excluding it truncated `TOKEN=abcdefgh,ijklmnop` and leaked the
remainder); the JSON unquoted pattern does exclude it, since comma is a
real JSON delimiter there. Also made the var-name match case-insensitive
(`.envrc`/shell scripts can use lowercase names like `github_token=`),
and added an unconditional backstop for credentials embedded in a
connection string/DSN (`postgres://user:pass@host` →
`postgres://REDACTED_SECRET@host`), independent of variable name.

**Known limitations, not fixed here**: PEM/SSH private-key blocks have no
`NAME=value` shape to match, and a bare secret value with no adjacent
key-name or URL context is out of reach of any name/value pattern
approach by construction. Flag for a future pass only if actually
observed leaking in a real run.

### Round 2, the same day — real enforcement on the PR-write channel, plus hardening

Adversarial review of the round-1 fix above (mirroring `research-loop`'s
own 3-agent review: logic/correctness, runtime-risk, security) found the
same architectural gap `research-loop` found on its Jira-comment channel:
the PR title/body channel had zero technical enforcement, just the prose
rule in `SKILL.md`. Round 2 broadens `SECRET_NAME_PATTERN` (adds
`SIGNING_KEY`/`ACCOUNT_KEY`/`ROLE_KEY`/`ENCRYPTION_KEY`/a standalone
`KEY`/`DSN`/`CONNECTION_STRING`/`DATABASE_URL`/`DB_URL`/`URI`/`COOKIE`/
`SESSION`, deliberately *not* a bare unanchored `KEY` substring match —
an earlier draft of this pattern would have matched `issueIdOrKey`,
present on nearly every Jira API response, and would have made the new
hook below deny legitimate calls), excludes `;` from
`ENV_UNQUOTED_PATTERN`'s value class (catches semicolon-delimited
connection-string segments like `AccountKey=`/`SharedAccessSignature=`
one segment at a time, no bespoke per-name pattern needed), adds three
bare-token format backstops (Stripe `sk_live_`/`rk_live_`/`pk_live_`,
GitHub `gh[oprsu]_`, Slack `xox[baprs]-`), and adds `containsSecret(text):
boolean` — a boolean check reusing `redactSecrets()`'s own patterns, one
source of truth.

**Caught by this round's own TDD process**: broadening
`SECRET_NAME_PATTERN` to include `DATABASE_URL`/`URI` initially broke the
existing connection-string-credential redaction — the generic name/value
pass started swallowing the *entire* URL value before
`CONNECTION_STRING_CREDENTIALS_PATTERN` (which redacts only the embedded
`user:pass@` segment and keeps host/port/path) got a chance to run. Fixed
by skipping URL-shaped values in the generic pass entirely, caught by two
pre-existing regression tests that would otherwise have silently broken.

**`src/main.ts`**: fixed a truncate-before-redact ordering bug in
`printStreamEvent()` — `--stream`'s live tool_use/tool_result echo
truncated output to 200 characters *before* calling `redactSensitive()`,
so a secret cut mid-value by truncation lost its closing quote and the
(now-unquoted) prefix printed in the clear. Fixed by redacting the full
value first, inside `truncate()` itself, then truncating the
already-redacted result. Verified by hand with a fake Stripe-shaped key
straddling the 200-char boundary (this file has no vitest coverage by
design).

**New: a code-level backstop on the PR title/body channel.** dev-loop has
no Jira-comment-writing tool at all — `ALLOWED_TOOLS` in `src/main.ts`
only grants read-only Atlassian MCP calls. The durable, human-facing
write this pipeline produces is the PR title/body, created via `gh pr
create`/`gh pr edit` — a `Bash` tool call, not a named MCP tool, which
made this a genuinely different matching problem than `research-loop`'s
fixed-tool-name matcher. Added a `PreToolUse` hook
(`.claude/hooks/block-secret-comments.sh` + `.claude/settings.json`)
matched on `Bash` itself: the hook script pre-filters cheaply (three
independent whole-word checks for `gh`, `pr`, and `create`/`edit` against
the command string) before ever invoking a new Node checker
(`scripts/check-secret-in-tool-input.ts`, reusing `containsSecret()`) —
chosen over scanning every single `Bash` call with Node, since `Bash` is
used constantly throughout every phase (git, tests, lint, build), unlike
`research-loop`'s much rarer Jira-write-only matcher. Denies (exit 2) any
`gh pr create`/`gh pr edit` command whose content matches a secret-shaped
pattern before it ever reaches the real `gh` CLI/GitHub API. Same
non-negotiable design points as `research-loop`'s hook, carried over
verbatim: the command string (which may contain PR body text straight
from ticket content) is read via stdin/`jq`/`JSON.parse` only, never
shell-interpolated or passed as a command-line argument; the hook fails
**closed** on any checker error (crash, bad stdin, missing file); and the
checker uses non-colliding exit codes (process exit 3 = secret found,
exit 2 = check failed) so a totally broken checker crashing before its
own error handling runs (Node's default crash exit code, 1) can't be
misread as "found a secret." Confirmed `$CLAUDE_PROJECT_DIR` is fixed to
this repo's own directory at hook-invocation time regardless of which
target-repo worktree a run later works in — `src/main.ts` spawns `claude
-p` with no `cwd` override, same as `research-loop`'s own verified
mechanism.

Also noted the new hook next to the existing PR-body secrets rule in
`SKILL.md` (~line 277).

**Residual gaps, round 2** (risk-reduction, not closed — same framing as
round 1): the hook is a name/format-anchored heuristic, not a semantic
secret detector. A bare secret value with no recognizable format (not one
of the three new bare-token shapes) and no adjacent key name still gets
through. PEM/SSH private-key blocks have no `NAME=value` or recognized
bare-token shape and remain unaddressed. A secret split across multiple
`gh pr edit` calls is scanned independently per call, not across the
run's history. A fully general high-entropy-string detector remains
explicitly out of scope (real false-positive cost, not a cheap addition
like the formats added this round).

## 2026-08-27 — Headless runs could stall forever on a Read permission prompt

`ALLOWED_TOOLS` in `src/main.ts` allowed `Bash` plus two Atlassian MCP
calls, but never `Read`, `Grep`, or `Glob`. `--permission-mode
acceptEdits` only auto-approves `Edit`/`Write`, not reads — and `Edit`
itself refuses to touch a file that hasn't been `Read` in-session first.
So the moment `ticket-to-pr` tried to edit a file it hadn't already
`cat`'d via `Bash`, it fell back to `Read`, hit an unanswerable
permission prompt (no human in a headless `-p` run), retried a few
times, and gave up without ever writing `verdict.json`.

Surfaced on `TARS-1341` (stuck retrying a `Read` on
`serverFetch.test.js` mid-Red-phase, three runs total once two
subsequent polls piled up and correctly bounced on the collision) but
had already caused the identical `agent_error` / "no run directory
appeared" signature on `TARS-1367` and four times in a row on
`TARS-1364` earlier — this was a recurring, intermittent failure, not a
one-off.

**Fix**: added `Read`, `Grep`, `Glob` to `ALLOWED_TOOLS` (`src/main.ts`).
