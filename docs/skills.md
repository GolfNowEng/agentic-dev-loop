# Skills

## ticket-refine

`.claude/skills/ticket-refine/SKILL.md` — the skeptic. Invoked by the loop
runner as `claude -p "/ticket-refine <TICKET-KEY>"`. Treats the raw ticket
as an unverified claim, not an instruction to execute, and runs a fixed
sequence against an isolated per-run `git worktree` off the shared target-
repo clone at `.pipeline/<slug>/repo` (see `docs/logging.md`) — never the
shared clone directly, so a human working in it manually is never affected
by a background run:

0. **Triage & route** — pick a checklist by issue type (Bug vs Tech Story
   vs unknown); for bugs, determine fault domain (client-side vs upstream
   service) before anything else.
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
2. **Ground** — pragmatic, hypothesis-driven investigation, not a lookup:
   creates this run's worktree first, then forms 2-3 concrete competing
   explanations when the cause isn't obvious. If any hypothesis needs a
   live API call to test (not just reading client code), `ticket-refine`
   starts the target repo's own dev server *once* inside that worktree,
   checking first whether one's already running — then fans out one
   `recon-agent` per hypothesis in parallel (below), each testing its own
   hypothesis against the worktree (and the running dev server's local
   proxy routes, if relevant). "More than one confirmed, or none" is a
   finding to carry into Attack, not something to silently resolve by
   picking one.
3. **Attack** — spawn `devils-advocate-agent` (below) to try to break the
   working assumptions from Interpret/Ground.
4. **Scope & sequence** — if oversized, draft (never create) a split as
   comments for the human gate to approve; bounce `too_large`.
5. **Blocked detection** — bounce `blocked` if work can't proceed regardless
   of spec quality (external dependency, missing access, upstream fault).
6. **Synthesize** — write the refined ticket (comments during work; the
   official templated description only on a passing verdict).
7. **Verify** — spawn `verifier-agent` (below) for an independent
   definition-of-ready check before reporting a passing verdict.

Core rule: a bounce is a normal, successful exit — concrete evidence, not a
crash. Everything questioned here happens *once*, upstream of the human
review gate; once a ticket crosses into Review, `dev-loop` trusts it fully.

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
  per-run worktree — never the shared clone — and can run the test suite
  or a throwaway repro script there, and, when `ticket-refine` handed it a
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
  attacks Interpret/Ground's assumptions across six angles (already fixed
  elsewhere? symptom vs. cause? hidden dependencies? blocked prerequisites?
  unstated scope? ambiguity Ground missed?). Surviving assumptions get
  written into the refined ticket's Overview, explicitly labeled as
  assumptions.
- **verifier-agent** (`.claude/agents/verifier-agent.md`) — an
  independent pass over the definition-of-ready checklist (see below); not
  the same reasoning that produced the ticket rubber-stamping itself.

## Definition-of-ready checklist

Enforced by `verifier-agent`, checked in order — first failure is the
bounce: (0) template sections populated, (1) every AC testable, (2) files/
modules named, (3) TDD-ready test expectations per AC, (4) small/medium size
bound, (5) no open questions, (6) a literal-minded Sonnet-tier implementer
could act on it without inferring anything.

## Model policy

`ticket-refine` itself runs on `--model opus` (pinned explicitly in the
invocation command — not an ambient default). Every subagent it spawns
(`recon-agent`, `devils-advocate-agent`, `verifier-agent`) pins `model:
sonnet` in its own frontmatter and does **not** inherit Opus from the
parent — a Step 2/3/7 fan-out does not multiply Opus cost. Opus is reserved
for this skill's own judgment calls (Interpret, synthesizing Attack's
findings, Scope, Synthesize); the subagents feed it evidence over
already-narrowed inputs, they don't independently re-run the expensive
reasoning.

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
