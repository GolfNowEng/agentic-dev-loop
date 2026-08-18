---
name: ticket-refine
description: Refine a raw Jira ticket into a Sonnet-executor-ready spec for ticket-to-pr. The skeptic role (spec section 5.0/5.1) - treats the raw ticket as a claim to be verified, grounds it against the codebase, attacks its own assumptions, and only then writes the refined ticket.
---

# ticket-refine

## Arguments

`$ARGUMENTS` — a single Jira ticket key, e.g. `TARS-1301`. Required.

## Role: the skeptic

Per spec section 5.0, this skill is the pipeline's deliberate bottleneck —
doubt is expensive (this runs at a higher tier, with codebase recon and
adversarial subagent fan-out), so it is spent exactly once per ticket,
upstream of the human review gate. Once a ticket crosses Review → Ready,
its contents stop being questioned; all the questioning happens here.

Treat the raw ticket as **a claim to be verified**, not an instruction to
execute. Your job is to either produce a ticket a literal-minded Sonnet-tier
implementer (`ticket-to-pr`) can execute without asking a single question,
or to bounce it with concrete evidence of why it isn't ready.

## Setup: idempotent re-refinement

**Always check first**: does this ticket already have prior refinement
output (a comment titled "Original description — preserved", or a
description already in the `### Overview` / `### Acceptance Criteria` /
`### Scope` template)? Two cases:

- **First pickup**: copy the original description verbatim into a comment
  titled "Original description — preserved" *before anything else happens*,
  so the initial intent is never lost. Then proceed through Steps 0–7 below
  as a fresh refinement.
- **Re-pickup after human comments** (ticket was sent back from the Review
  epic to an Intake epic with a comment): read the human's comment(s) as
  steering input, and **revise** the existing refinement rather than
  starting over from scratch. Re-run only the steps the comment calls into
  question (e.g. if the human flagged an incorrect fault-domain call,
  redo Step 0's fault-domain determination and Step 6's synthesis; you
  don't need to redo Step 2's codebase grounding if it wasn't disputed).

## Setup: run directories and progress logging

Same discipline as `dev-loop`'s `ticket-to-pr`, for dashboard parity:

1. `RUN_ID` = current UTC timestamp as `YYYYMMDDTHHMMSSZ`.
2. `RUN_DIR` = `.pipeline/runs/<TICKET>-<RUN_ID>/` (relative to this repo's
   root). Create it.
3. Append one JSON line per phase transition to `RUN_DIR/progress.jsonl`:
   ```json
   {"ts": "<ISO-8601 UTC>", "phase": "triage|interpret|ground|attack|scope|blocked-check|synthesize|verify", "event": "phase_start|phase_end|note", "detail": "one line"}
   ```
4. The final event, always emitted regardless of outcome, is
   `"event": "result"` — see "Always-emitted result line" below.

## Target repo (grounding)

`pipeline.config.json`'s `targetRepo` names the codebase this skill grounds
tickets against — `webtarsthree`
(`git@github.com:fandango/webtarsthree.git`, default branch `master`). This
is a **read-only** checkout for this skill — `ticket-refine` never commits
or branches in the target repo, it only reads code to verify or contradict
the ticket's claims.

Working directory: reuse the same persistent checkout convention as
`ticket-to-pr` (`.pipeline/workdir/webtarsthree`), but this skill only ever
runs `git fetch` + `git checkout <defaultBranch>` + `git reset --hard
origin/<defaultBranch>` at the start — never creates a branch, since it
makes no commits.

## Always-emitted result line

Whatever step this run ends at, the last thing this skill does is emit one
line — to stdout, as the final `progress.jsonl` event, and as
`verdict.json`'s `detail` field:

- `RESULT: ready — refined ticket written` (passing verdict)
- `RESULT: bounced (<failure_category>) — <one-line reason with concrete evidence>`
- `RESULT: error — <what went wrong>` (tooling/environment failures only —
  spec problems are always `bounced`)

## The skeptic sequence

### Step 0 — Triage & route

Read the Jira issue type. Select the matching checklist — all checklists
share Steps 1–7 below, but this step's findings feed what "Ground" and
"Attack" specifically look for. Skepticism scales with issue type and how
much information the ticket arrived with.

- **Bug checklist**: reproduce it. **Determine fault domain** — is this
  broken in webtarsthree's own code, or is a backend service/API not
  returning what its contract promises? Inspect the failing call, the
  service response, the contract. If the fault is upstream: bounce
  `blocked`, naming the owning service, and draft a follow-up ticket for
  that team (see Step 4) rather than pretending webtarsthree can fix it
  client-side. Then determine: regression window (when did it last work?
  — check git log/blame on the relevant area), severity, affected surface.
- **Tech Story checklist**: verify the ticket's claims about current
  architecture against the actual code. Check dependencies and
  prerequisites. Consider migration/rollout implications. Determine
  whether the story is genuinely one change or a disguised epic.
- **Unknown/other issue types**: run the fullest, most skeptical version of
  the above (treat as if it were a Tech Story with an unclear fault
  domain).

### Step 1 — Interpret

Restate what the ticket is actually asking, in your own words. If more than
one reading is plausible, enumerate them explicitly. An unresolvable
ambiguity here is an immediate bounce (`spec_ambiguous`, listing the
readings) — not a coin flip, not "pick the most likely one and proceed."

### Step 2 — Ground

Spawn codebase reconnaissance subagents (see `.claude/agents/recon-agent.md`)
against the `webtarsthree` checkout: does the described problem exist as
stated? Locate the relevant code. Reproduce the bug, or confirm the gap the
ticket describes actually exists.

If the codebase contradicts the ticket's claim (the described behavior
doesn't happen, the referenced file/function doesn't exist, the bug is
already fixed) — bounce `spec_contradicted` with the specific evidence
(file, line, what you found vs. what the ticket claims).

### Step 3 — Attack

Spawn a devil's-advocate subagent (see
`.claude/agents/devils-advocate-agent.md`) to try to break the working
assumptions from Steps 0–2: Is this already fixed elsewhere in the
codebase? Is the ask a symptom of a deeper cause the ticket doesn't name?
Are there hidden dependencies, blocked prerequisites, or scope the ticket
didn't mention?

Every assumption that survives this attack gets written into the refined
ticket's `### Overview` **explicitly labeled as an assumption** — the human
gate needs to see what's load-bearing, not have it silently baked in.

### Step 4 — Scope & sequence

If the verified work (after Steps 1–3) exceeds the small/medium size bound,
draft a split: an ordered set of follow-up ticket drafts with dependencies
noted between them. **Do not create these tickets yourself.** Draft them as
comments/notes for the human gate — Justin approves splits before any new
ticket is created; the machine proposes, the human authorizes.

If this step concludes the ticket is oversized, bounce `too_large` with the
suggested split attached as evidence, rather than synthesizing a
partial/incorrect ticket.

### Step 5 — Blocked detection

If the work can't proceed regardless of how well-specified it is (external
dependency, missing access, an upstream decision needed, or the Step 0
fault-domain finding pointed outside webtarsthree) — bounce `blocked`,
naming the specific blocker.

### Step 6 — Synthesize

Write the refined ticket. Per the ticket content protocol (below), this
means writing to the ticket's **comments** during work, and only writing
the official retemplated **description** once a passing verdict is
reached in Step 7.

### Step 7 — Verify

Spawn a verifier subagent (see `.claude/agents/verifier-agent.md`) to check
the synthesized ticket against the definition-of-ready checklist below.
This must be a genuinely independent check, not the same reasoning that
produced the ticket rubber-stamping itself.

- If it passes: write the official description (see ticket content
  protocol), set `verdict.outcome: "ready"`, move to Review epic (the loop
  runner does the actual epic move on a passing verdict — this skill just
  reports the verdict).
- If it fails: bounce with the specific `failure_category` and what's
  missing, per the checklist's own criteria.

## Definition-of-ready checklist (enforced, not vibed)

0. Description follows the official template: `### Overview`,
   `### Acceptance Criteria`, `### Scope` present and populated; original
   description preserved in a comment.
1. Problem statement and every acceptance criterion are testable (each AC
   maps to an assertion `ticket-to-pr` could write a test against).
2. Files/modules to touch are enumerated by name — no "relevant files"
   hand-waving.
3. Test expectations stated in TDD-ready form: each AC names the test
   `ticket-to-pr` will write **first** (test name, what it asserts, why it
   must fail on current code), plus which existing suites must stay green.
4. Size estimate within the small/medium bound; anything larger bounces
   `too_large` with a suggested split (Step 4).
5. No open questions requiring human decision — else bounce
   `spec_ambiguous` listing the questions.
6. Written to the Sonnet-executor standard: no step requires inference or
   judgment to act on. The verifier asks, for each AC: "could a
   literal-minded implementer do this without asking anything?"

## Ticket content protocol

1. On first pickup, the original description is copied verbatim into a
   comment ("Original description — preserved") before anything else
   happens.
2. All work-in-progress — interpretation notes, recon findings, assumption
   attacks, iteration updates — flows through **comments**. The
   description is never used as a scratchpad.
3. Only on a passing verdict does this skill write the **official
   description**, in the fixed template:
   - `### Overview` — problem statement, verified context, fault domain
     (for bugs), surviving assumptions (labeled as assumptions)
   - `### Acceptance Criteria` — TDD-ready: each AC names its test, what it
     asserts, why it fails on current code
   - `### Scope` — files/modules to touch, size estimate,
     sequencing/follow-up drafts if split
4. The Step 7 verifier checks the description *format* as well as content —
   a refined ticket without these sections is not ready by definition.

## Bouncing (any step)

A bounce is a normal, successful exit — not a crash. On any bounce:

1. Write findings to a ticket comment (never the description) with concrete
   evidence — file paths, what was found vs. claimed, the specific
   ambiguous readings, the suggested split.
2. Write `verdict.json` with `outcome: "bounced"`, the step you stopped at
   as `phase_reached` (use the closest match: `triage`→`intake`,
   `interpret`/`ground`/`attack`→`plan`, `scope`/`blocked-check`→`plan`,
   `synthesize`→`red`, `verify`→`verify` — the loop's `PhaseReached` enum
   is shared across both skills, so map onto its nearest equivalent), a
   `failure_category` from the closed enum, and a `detail` string with the
   concrete evidence.
3. Emit the always-emitted result line and stop.

**Closed failure_category enum**: `spec_ambiguous · spec_contradicted ·
blocked · too_large · tests_flaky · env_setup · verify_rejected ·
subagent_stall · merge_conflict · agent_error · killed_ceiling`

This skill will only ever self-report `spec_ambiguous`, `spec_contradicted`,
`too_large`, or `blocked` — the others belong to `ticket-to-pr` or the loop
runner's own failure modes.

## verdict.json schema

Write to `RUN_DIR/verdict.json`:

```json
{
  "outcome": "ready | bounced | error",
  "phase_reached": "intake | plan | red | green | verify | pr",
  "failure_category": null,
  "detail": "the always-emitted result line's content, without the RESULT: prefix",
  "skill_version": "<git SHA of this SKILL.md's commit in research-loop>",
  "model": "opus",
  "cost_usd": 0,
  "tokens": { "in": 0, "out": 0 }
}
```

Note: `outcome: "ready"` here is this skill's own success signal; the loop
runner's `RunOutcome` type also has `"landed"` (used by `ticket-to-pr`) —
both map to a passing verdict, `ready` is simply the more accurate word for
what this skill produces (a ticket, not a PR). `cost_usd`/`tokens` are left
as `0`/zeros — the loop runner derives real values from `claude -p
--output-format json`'s own usage report.

## Invocation (for the loop runner)

```
claude -p "/ticket-refine <TICKET-KEY>" --permission-mode acceptEdits --output-format json
```
