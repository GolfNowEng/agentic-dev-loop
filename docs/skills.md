# Skills

## ticket-refine

`.claude/skills/ticket-refine/SKILL.md` — the skeptic. Invoked by the loop
runner as `claude -p "/ticket-refine <TICKET-KEY>"`. Treats the raw ticket
as an unverified claim, not an instruction to execute, and runs a fixed
sequence against an isolated per-run `git worktree` branched off
`targetRepo.path` (a local checkout, if configured) or a shared fetch-only
clone at `.pipeline/<slug>/repo` otherwise (see `docs/logging.md`) — never
that source checkout directly, so a human working in it manually is never
affected by a background run:

0. **Triage & route** — pick a checklist by issue type (Bug vs Tech Story
   vs unknown); for bugs, determine fault domain (client-side vs upstream
   service) before anything else.
0.5. **Open/link the GitHub Issue** — opens/renames this run's mirror
   GitHub Issue (created or found by `main.ts` right after claim, per
   Phase 1 of `docs/future-enhancements.md`'s Jira label-trigger design)
   before Interpret, and remembers its number/URL for every GitHub-only
   comment the rest of the run writes.
1. **Interpret** — first exhausts available Jira context (this ticket's own
   comment thread, and linked issues one hop out) before concluding
   anything is ambiguous; only then restates the ask. More than one
   plausible reading *after* that context check is an immediate bounce
   (`spec_ambiguous`), never a coin flip. A cheap pre-gate before Ground
   catches only the zero-signal case (a bug with no repro/error/surface
   named at all, or a story with no AC and no current-vs-desired
   description) and bounces there without paying for subagent fan-out —
   everything short of that (including ordinary thin tickets) proceeds to
   Ground/Attack, and only bounces afterward if the investigation itself
   can't resolve the gap. Tickets here vary a lot by author and are often
   under-specified; the default is to investigate and bounce with
   evidence, not to bounce on input alone.
2. **Ground** — starts with a cheap **currency check**: one direct
   `Read`/`grep` on the specific file(s)/behavior the ticket names — no
   subagent fan-out — to confirm the ticket's premise still holds before
   paying for anything expensive. Fully resolved (the described gap no
   longer exists at all) bounces `spec_contradicted` right there, cheaply.
   Partially stale (real work remains, but the ticket's framing is wrong —
   e.g. it assumes a file needs creating when it already exists and the
   actual gap is extending it) is *not* a bounce: the premise is corrected
   in place and the run continues with the corrected understanding, since
   the work is real, just mis-described — a bounce here would just cost a
   human round-trip for something fixable in the same run. Only past this
   check does it become pragmatic, hypothesis-driven investigation, not a
   lookup: creates this run's worktree first, then forms 2-3 concrete
   competing explanations when the cause isn't obvious. If any hypothesis
   needs a live API call to test (not just reading client code),
   `ticket-refine` starts the target repo's own dev server *once* inside
   that worktree, checking first whether one's already running — then
   fans out one `recon-agent` per hypothesis in parallel (below), each
   testing its own hypothesis against the worktree (and the running dev
   server's local proxy routes, if relevant). "More than one confirmed, or
   none" is a finding to carry into Attack, not something to silently
   resolve by picking one.
3. **Attack** — spawn `devils-advocate-agent` (below) to try to break the
   working assumptions from Interpret/Ground.
4. **Scope & sequence** — if oversized, draft (never create) a split as
   comments for the human gate to approve; bounce `too_large`.
5. **Blocked detection** — bounce `blocked` if work can't proceed regardless
   of spec quality (external dependency, missing access, upstream fault).
6. **Synthesize** — write the refined ticket (working comments during work
   go to the GitHub Issue, not Jira, per Phase 1's routing rule; on a
   passing verdict, the full `## ✅ research-loop - <short context>`
   content goes to the GitHub Issue and a short pointer comment of the
   same title convention goes to Jira). The stakeholder's original
   description is never touched, ever — see "Jira/GitHub content routing
   (Phase 1)" below.
7. **Verify** — spawn `verifier-agent` (below) for an independent
   definition-of-ready check before reporting a passing verdict.

Core rule: a bounce is a normal, successful exit — concrete evidence, not a
crash. Everything questioned here happens *once*, upstream of the human
review gate; once a ticket crosses into Review, `dev-loop` trusts it fully.
A bounce is written to one comment titled `❌ research-loop - <short
context>` — same greppable leading-icon + `research-loop -` prefix
convention as the passing-verdict `✅ research-loop - <short context>`
comment, in the same Context + Needs-decision shape as a passing verdict
(see `SKILL.md`'s "Ticket content protocol" item 3), so a human can tell
at a glance what decision unblocks the ticket. Neither title carries an
@-mention — dropped as excessive in practice (see `CHANGELOG.md`).

**Cleanup is a hard gate, unconditional, every run**: stop the dev server if
one was started, and remove this run's worktree — regardless of outcome
(ready, bounced at any step, or error). Since this skill never commits,
there's no "leave it for inspection" exception here (unlike `ticket-to-pr`,
which has one for uncommitted work — see dev-loop's `docs/skills.md`).

## Subagents

- **recon-agent** (`.claude/agents/recon-agent.md`) — one instance per
  hypothesis (spawned in parallel when Ground has more than one candidate
  explanation); each confirms or refutes only its own hypothesis, not a
  generic "does the ticket hold" pass. Works inside `ticket-refine`'s
  per-run worktree — never the checkout it was branched from — and can run
  the test suite or a throwaway repro script there, and, when `ticket-refine` handed it a
  running dev server's local URL, make live **read-only** calls against
  that instance's own proxy routes (never any other host, never a mutating
  call) — chained calls (e.g. search for an id, then fetch it) are expected
  when that's what it takes to see an endpoint's real response. It never
  starts/stops the dev server or manages the worktree itself — both
  lifecycles belong to `ticket-refine`. Trial and error is expected: a
  first attempt not panning out isn't grounds to report `inconclusive`
  without trying a different angle. For bugs, also determines fault domain
  and, via `git log -p`/`git blame` on the specific file(s), the regression
  window — while scanning that commit history for Jira keys that lead to a
  prior ticket which touched the same code. Never proposes a fix.
- **devils-advocate-agent** (`.claude/agents/devils-advocate-agent.md`) —
  attacks Interpret/Ground's assumptions across four angles (symptom vs.
  cause? hidden dependencies? unstated scope? ambiguity Ground missed?) —
  deliberately narrowed from an earlier six to angles judgeable from
  Interpret/Ground's own findings, without needing this subagent's own
  open-ended codebase exploration (which risked running long enough to hit
  the CLI's own background-task time limit in headless mode); "already
  fixed elsewhere?" and "blocked prerequisites?" were dropped, the latter
  because it's redundant with Step 5's own "Blocked detection." Surviving
  assumptions get written into the refined ticket's Overview, explicitly
  labeled as assumptions.
- **verifier-agent** (`.claude/agents/verifier-agent.md`) — an
  independent pass over the definition-of-ready checklist (see below); not
  the same reasoning that produced the ticket rubber-stamping itself.

## Definition-of-ready checklist

Enforced by `verifier-agent`, checked in order — first failure is the
bounce: (0) template sections populated (the full Overview/AC/Scope now
lives in the GitHub Issue's `## ✅ research-loop - <short context>`
comment, not Jira, per "Jira/GitHub content routing (Phase 1)" below —
the Jira comment is just its pointer), (1) every AC testable, (2)
files/modules named, (3) TDD-ready
test expectations per AC, (4) small/medium size bound, (5) no open
questions, (6) a literal-minded Sonnet-tier implementer could act on it
without inferring anything, (7) no raw secret/credential/token/password
value anywhere in the draft (presence/shape only — see Ticket content
protocol). Item 7 also has a code-level backstop: a `PreToolUse` hook
(`.claude/hooks/block-secret-comments.sh`) denies any Jira/Confluence write
whose content matches a known secret name or format pattern before it
reaches the real API — see `CHANGELOG.md`'s "Round 2" entry. Phase 1 added
a mirror-image hook, `.claude/hooks/block-github-secret-writes.sh`, denying
the equivalent `gh issue create`/`edit`/`comment` shape, since working
content now flows to GitHub too (see "Jira/GitHub content routing (Phase
1)" below). Neither hook is a replacement for this checklist item, just a
heuristic backstop behind it.

## Ticket content protocol

`ticket-refine` **never writes to the Jira description field.** The
stakeholder's original description is permanent and untouched — tickets
are authored by many different people in many different styles, and
normalizing someone else's ticket into our house format is bad practice
regardless of how good the result is.

Before Phase 1, all refined output — the normalized Overview/AC/Scope,
grounding evidence, surviving assumptions — went into one Jira comment,
written once on a passing verdict, titled exactly `Refined Spec — ready
for ticket-to-pr`, which `dev-loop`'s `ticket-to-pr` read as its work
order. Phase 1 splits that single comment across Jira and a mirror GitHub
Issue — see "Jira/GitHub content routing (Phase 1)" immediately below for
the current rule. A later, undated change (see `CHANGELOG.md`) replaced
that fixed title, both outcomes, with `{✅|❌} research-loop - <short
context>`, and replaced the pointer's section-manifest line with a clean
`[GitHub Issue](<url>)` link — `ticket-to-pr` keeps reading the Jira
comment as its work order until dev-loop migrates in Phase 2 (see
dev-loop's `docs/skills.md`); until then the Jira comment's link is what
a human clicks through to review the GitHub Issue's full content.

## Jira/GitHub content routing (Phase 1)

Per Phase 1 of `docs/future-enhancements.md`'s Jira label-trigger design,
`ticket-refine` now writes to two surfaces instead of one. **Jira gets only
four kinds of content** — a blocking ambiguity needing a human product
decision (`spec_ambiguous`), a scope call (`too_large` and its drafted
split), an explicit confirmation request, and the passing-verdict pointer
comment — **everything else goes to the GitHub Issue**: recon findings,
devil's-advocate attack findings, verifier results, working/interpretation
notes, and bounce evidence detail not itself one of the four Jira-worthy
kinds. Phase 1 introduced a requirement that every Jira comment under this
rule @-mention `jira.mentionAccountId` (`Config.jira.mentionAccountId`);
a later change (see `CHANGELOG.md`) dropped that requirement as excessive
in practice — `jira.mentionAccountId` stays in config, unused, for now.
See `SKILL.md`'s "Ticket content protocol" for the full routing rule
(items 1-8) and Step 0.5 for how the GitHub Issue is found/renamed each
run.

**Design decision (Task 4): GitHub Issue creation is loop-runner-owned, not
skill-owned.** `src/main.ts` creates or finds the mirror Issue (via
`GitHubClient.findIssueByJiraKey`/`createIssue`) immediately after claiming
a ticket, *before* spawning `ticket-refine` — not inside the skill itself.
This keeps the idempotency check (does an Issue for this Jira key already
exist) in TypeScript, backed by `test/github-client.test.ts`'s TDD suite,
rather than re-implemented as prompt instructions the skill would have to
get right on every run. `ticket-refine`'s Step 0.5 only looks up and
renames the Issue `main.ts` already created — it never creates one itself.
A GitHub Issue creation failure in `main.ts` never blocks the actual
`ticket-refine` run (same never-throw contract as every other I/O boundary
in `runSkill`); the skill proceeds without a mirror Issue for that run,
noting it once in `progress.jsonl`, and a later run's idempotency check
will retry.

## Model policy

`ticket-refine` itself runs on `--model sonnet` (pinned explicitly in the
invocation command — not an ambient default). It originally ran on Opus,
reserved in intent for this skill's own judgment calls (Interpret,
synthesizing Attack's findings, Scope, Synthesize) — but a single
continuous `claude -p` session bills *every* turn at one model tier, not
just the turns that need deep reasoning, so Triage/Ground bookkeeping/every
intermediate turn paid Opus pricing too. That drove real cost without a way
to scope Opus to just the four steps short of a larger re-architecture
(splitting into a Sonnet-tier orchestrator that calls out to Opus only for
specific steps). Switched to Sonnet for the whole session as the simpler
fix — revisit (either back to Opus, or the split-orchestrator design) if
bounce/synthesis judgment quality visibly degrades on real tickets. Every
subagent it spawns (`recon-agent`, `devils-advocate-agent`, `verifier-agent`)
pins `model: sonnet` in its own frontmatter regardless of the parent's tier.

## verdict.json contract

Every skill run writes `RUN_DIR/verdict.json` (schema in the SKILL.md file
itself). The loop runner (`src/loop-runner.ts`) reads it via
`parseVerdict()` in `src/verdict.ts` — a missing or malformed file becomes
`outcome: "error"`, `failure_category: "agent_error"`, never a crash.

**Closed `failure_category` enum** — do not add or remove values without
updating the pipeline spec: `spec_ambiguous · spec_contradicted · blocked ·
too_large · tests_flaky · env_setup · verify_rejected · subagent_stall ·
merge_conflict · agent_error · killed_ceiling`. This skill only ever
self-reports `spec_ambiguous`, `spec_contradicted`, `too_large`, or
`blocked`.
