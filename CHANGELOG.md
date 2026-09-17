# Changelog

Notable fixes and behavior changes to the research-loop pipeline itself
(`src/`, `.claude/skills/ticket-refine/`, `.claude/agents/`). Newest
first. Not every commit needs an entry — only ones that change what the
loop is capable of or fix a failure mode a human had to diagnose.

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
