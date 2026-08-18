# Skills

## ticket-refine

`.claude/skills/ticket-refine/SKILL.md` — the skeptic. Invoked by the loop
runner as `claude -p "/ticket-refine <TICKET-KEY>"`. Treats the raw ticket
as an unverified claim, not an instruction to execute, and runs a fixed
sequence against a **read-only** target-repo checkout at
`.pipeline/<slug>/workdir/<slug>`:

0. **Triage & route** — pick a checklist by issue type (Bug vs Tech Story
   vs unknown); for bugs, determine fault domain (client-side vs upstream
   service) before anything else.
1. **Interpret** — restate the ask; more than one plausible reading is an
   immediate bounce (`spec_ambiguous`), never a coin flip.
2. **Ground** — spawn `recon-agent` (below) against the target repo to
   verify or contradict the ticket's factual claims.
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

## Subagents

- **recon-agent** (`.claude/agents/recon-agent.md`) — narrow codebase
  grounding: does the described problem/claim actually hold against the
  code? For bugs, also determines fault domain and (if discoverable) the
  regression window via git log/blame. Never proposes a fix.
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
