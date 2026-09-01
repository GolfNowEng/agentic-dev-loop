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

**Always check first**: does this ticket already have a `Refined Spec —
ready for ticket-to-pr` comment? Two cases:

- **First pickup** (no such comment exists): proceed through Steps 0–7
  below as a fresh refinement. The ticket's description is never touched —
  it's the stakeholder's original and stays exactly as written, permanently.
- **Re-pickup after human comments** (ticket status was reset to `To Do`
  with a steering comment added, still in this same epic — research-loop's
  intake and spec-review territory is one combined epic, not two, so
  there's no epic to move between): read the human's comment(s) as
  steering input, and **revise** the existing refinement rather than
  starting over from scratch. Re-run only the steps the comment calls into
  question (e.g. if the human flagged an incorrect fault-domain call,
  redo Step 0's fault-domain determination and Step 6's synthesis; you
  don't need to redo Step 2's codebase grounding if it wasn't disputed).

## Setup: run directories and progress logging

Same discipline as `dev-loop`'s `ticket-to-pr`, for dashboard parity:

1. `RUN_ID` = current UTC timestamp as `YYYYMMDDTHHMMSSZ`.
2. `SLUG` = the project slug derived from `pipeline.<project>.config.json`'s
   `targetRepo.url` (same derivation as `repoSlugFromUrl` in `src/config.ts`
   — the last path segment, minus a trailing `.git`), e.g. `webtarsthree`.
3. `RUN_DIR` = `.pipeline/<SLUG>/runs/<TICKET>-<RUN_ID>/` (relative to this
   repo's root). Create it. Namespacing by `SLUG` lets multiple projects'
   runs coexist under one `research-loop` checkout without collision.
4. Append one JSON line per phase transition to `RUN_DIR/progress.jsonl`:
   ```json
   {"ts": "<ISO-8601 UTC>", "phase": "triage|interpret|ground|attack|scope|blocked-check|synthesize|verify", "event": "phase_start|phase_end|note", "detail": "one line"}
   ```
5. The final event, always emitted regardless of outcome, is
   `"event": "result"` — see "Always-emitted result line" below.

## Target repo (grounding)

This repo's `pipeline.<project>.config.json`'s `targetRepo` names the
codebase this skill grounds tickets against — currently
`pipeline.webtarsthree.config.json` points at `webtarsthree`
(`git@github.com:fandango/webtarsthree.git`, default branch `master`). This
skill never commits — it only reads code (and, via a dev server, exercises
it) to verify or contradict the ticket's claims. Adding a second project
later means adding a second `pipeline.<project>.config.json` — no code or
skill changes.

**Per-run worktree, nested inside the target repo itself — never work
directly in a shared checkout.** At the start of Step 2 (Ground) — the
only step that touches the target repo — create an isolated, detached
worktree for this run **inside** the target repo's own directory tree
(`<targetRepo.path>/.claude/worktrees/...`, not a sibling path elsewhere), so
tools like `direnv` that activate by walking up from the current
directory pick up the target repo's own `.envrc`/local env automatically
— a worktree living outside that tree never can, no matter what. Never
work directly in `targetRepo.path` itself, since a human may `cd` into it
or be mid-inspection of a prior run's worktree at any moment while this
loop runs unattended in the background:

```bash
git -C <targetRepo.path> fetch origin
git -C <targetRepo.path> worktree add --detach \
  <targetRepo.path>/.claude/worktrees/<TICKET>-<RUN_ID>-ground \
  origin/<targetRepo.defaultBranch>
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
git -C .pipeline/<SLUG>/repo worktree add --detach \
  .pipeline/<SLUG>/repo/.claude/worktrees/<TICKET>-<RUN_ID>-ground \
  origin/<targetRepo.defaultBranch>
```

Ground, and every `recon-agent` it spawns, reads and executes only inside
the `.claude/worktrees/<TICKET>-<RUN_ID>-ground` directory just created — never
in `targetRepo.path` or `.pipeline/<SLUG>/repo` themselves. See "Cleanup"
below for removing this worktree once Ground (and the rest of the run)
concludes — the `git worktree remove` target is whichever checkout
(`targetRepo.path` or `.pipeline/<SLUG>/repo`) the worktree was created
from.

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
  broken in the target repo's own code, or is a backend service/API not
  returning what its contract promises? Inspect the failing call, the
  service response, the contract. If the fault is upstream: bounce
  `blocked`, naming the owning service, and draft a follow-up ticket for
  that team (see Step 4) rather than pretending the target repo can fix it
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

Before restating the ask, exhaust the context Jira itself already has —
don't declare something ambiguous or under-specified until you've checked:

1. **This ticket's own comment thread** (`getJiraIssue` with `comment` in
   `fields`, or the equivalent comment-listing call) — read every comment,
   not just the description. A prior discussion may already answer the
   exact question you're about to flag as open.
2. **Linked issues, one hop** — any ticket connected via `relates to` /
   `blocks` / `is blocked by` / `duplicates` on this ticket (its own link
   data, no further traversal from those tickets). Read their
   summary/description/comments too. A linked ticket may contain the
   missing fault-domain call, a prior decision, or evidence this exact
   ambiguity was already resolved elsewhere.

Only after checking both: restate what the ticket is actually asking, in
your own words. If more than one reading is *still* plausible after that
context, enumerate the readings explicitly. An unresolvable ambiguity here
is an immediate bounce (`spec_ambiguous`, listing the readings and noting
what the comment thread/linked tickets did or didn't resolve) — not a coin
flip, not "pick the most likely one and proceed."

**Cheap pre-gate before Ground.** Tickets here vary widely in how much the
reporter wrote — thin tickets are common and are not, by themselves, a
reason to bounce; Ground/Attack below exist specifically to do the
investigation a thin ticket didn't do for itself, and a bounce should
normally come *after* that investigation fails to resolve the gap, with the
investigation's own evidence attached. But before paying for subagent
fan-out, check for the **zero-signal** case — nothing concrete enough for
Ground to even locate code against:
- Bug with no repro steps, no error text, and no named surface (page,
  endpoint, component) — not even a vague one.
- Tech Story / other with no acceptance criteria of any kind and no
  described current-vs-desired behavior.

If (and only if) this ticket is genuinely zero-signal after the comment
thread and linked-issue check above — bounce now, `spec_ambiguous`, detail
naming specifically what's missing (not "ticket is thin," which is
everywhere; the *specific* absence — e.g. "no repro steps, no error
message, no page/endpoint named"). This is a narrow gate: a thin-but-not-
empty ticket ("the export button doesn't work") still has enough of a
surface to Ground against and should proceed. Skip this gate entirely (go
straight to Step 2) once there is *anything* concrete to investigate.

### Step 2 — Ground

This step is pragmatic investigation, not a lookup. Approach it the way a
developer would debug something unclear: form hypotheses, then work through
them with trial and error until one is confirmed or all are exhausted —
don't stop at the first plausible-looking explanation without checking
whether it actually holds.

0. **Currency check, before anything else in this step.** Before forming
   hypotheses or spawning any `recon-agent`, do one cheap, direct check —
   a `Read`/`grep` on the specific file(s)/behavior/test the ticket names,
   not a fan-out — to confirm the ticket's premise is still current. Tickets
   can go stale: the described gap may already be fully closed, or partially
   closed (e.g. a test file the ticket claims doesn't exist actually does,
   but the specific coverage the ticket is really asking for is still
   missing). This exists because the expensive parallel hypothesis machinery
   below is the wrong tool for "does this still need doing at all" — that
   question should be answered by one cheap read, not a multi-hypothesis
   investigation that only discovers the contradiction after paying for it.
   - **Fully resolved** (the described problem/gap no longer exists at
     all — already fixed, file already does what's asked, nothing left to
     do): bounce `spec_contradicted` right here, cheaply, with the specific
     evidence (file, line, what you found vs. what the ticket claims). Do
     not proceed to hypothesis-forming.
   - **Partially stale** (real work still exists, but the ticket's framing
     of it is wrong — e.g. it assumes a file must be created when it
     already exists and the actual gap is extending it, or assumes a
     symptom that's now different from what's actually broken): this is
     not a bounce. Correct your working understanding of the premise (note
     the correction, e.g. "extend the existing file" instead of "create a
     new one") and continue into hypothesis-forming with the corrected
     premise — the work is real, just mis-described; a bounce here would
     just cost a human round-trip for something this skill can fix in the
     same run.
   - **Premise holds**: proceed as normal.
1. **Form hypotheses.** If the cause or the described behavior isn't
   obvious from a first read, write down 2–3 concrete, distinct candidate
   explanations (not "something's wrong in the auth flow" — specific enough
   that confirming or refuting one wouldn't also confirm or refute another).
   If there's genuinely only one plausible explanation, that's fine — this
   is about not stopping at the first guess when there's real ambiguity,
   not manufacturing multiple hypotheses for their own sake.
2. **If any hypothesis needs a live API call to test** (not just reading
   client code — actually seeing what an endpoint returns), start the
   target repo's own dev server *once*, in the worktree created above,
   before spawning any `recon-agent`. Check whether it's already running
   first (e.g. hit its health-check route) — don't start a second instance.
   Start it per the target repo's own dev script (check its
   `package.json`/README, don't assume a command) and wait for it to be
   ready. Note the local URL(s) it's serving on (e.g. `http://localhost:3000`
   with `/api` proxied to a local API server) — this is what you pass to
   each `recon-agent` that needs it. If it fails to start, or starts but
   can't reach whatever upstream services it depends on (e.g. missing local
   credentials in a freshly cloned checkout), live API verification is
   simply unavailable for this run — `recon-agent` reports that plainly
   rather than guessing at a response shape or treating static code-reading
   as equivalent evidence. (Cleanup, including stopping this server, is
   covered once for the whole run — see "Cleanup" below.)
3. **Fan out one `recon-agent` per hypothesis, in parallel** (see
   `.claude/agents/recon-agent.md`) — each spawned to confirm or refute one
   specific hypothesis against the worktree (and, if you started one, the
   running dev server's local URL), not a generic "does the described
   problem exist" pass. Parallel fan-out here is about testing competing
   explanations at once, not increasing scrutiny of a single explanation.
4. Each `recon-agent` should actually try to confirm its hypothesis, not
   just read code and infer: run the existing test suite, write a
   throwaway repro script, or — if the dev server is running — make live,
   read-only calls against its local proxy routes to see what an endpoint
   actually returns (e.g. search for an item to get its id, then call the
   real endpoint with that id to reproduce the reported behavior). See
   `recon-agent.md` for the local-API rules.
5. Collect what each hypothesis's `recon-agent` found. If one is confirmed
   with concrete evidence, that's your grounding. If more than one is
   confirmed, or none is, that's itself a finding — carry it into Attack
   (Step 3) rather than picking one to move forward with.

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
fault-domain finding pointed outside the target repo) — bounce `blocked`,
naming the specific blocker.

### Step 6 — Synthesize

Write the refined ticket. Per the ticket content protocol (below), this
means writing to **working comments** during work, and only writing the
official `Refined Spec — ready for ticket-to-pr` comment once a passing
verdict is reached in Step 7. The description is never touched.

### Step 7 — Verify

Spawn a verifier subagent (see `.claude/agents/verifier-agent.md`) to check
the synthesized ticket against the definition-of-ready checklist below.
This must be a genuinely independent check, not the same reasoning that
produced the ticket rubber-stamping itself.

- If it passes: write the `Refined Spec — ready for ticket-to-pr` comment
  (see ticket content protocol), set `verdict.outcome: "ready"`. The
  ticket stays in this same epic, refined and awaiting human approval
  (the loop runner only moves it to dev-loop's epic if `autoPromoteLabel`
  is present — this skill just reports the verdict either way).
- If it fails: classify the failure before deciding what to do with it —
  see "Self-heal vs. bounce" below. Never skip this classification and
  bounce by default; a mechanical failure resolved via self-heal is a
  *better* outcome than a bounce, not a fallback.

#### Self-heal vs. bounce

A Verify failure is exactly one of two kinds. Get this classification
wrong in either direction and you either burn a human round-trip on
something the machine could fix itself, or you quietly paper over a real
decision that was supposed to reach the human — so this is a genuine
judgment call, not a formality.

**Mechanical** (self-heal in this same run, do not bounce): the fix has
exactly one correct answer, fully derivable from evidence Ground/Attack
already gathered in this run — no new investigation, no tradeoff, no
stakeholder preference involved. The verifier names the gap; closing it
is transcription, not decision-making. Concrete examples, all drawn from
real runs:

- A mocked dependency has no default return value, and the component
  under test calls it unconditionally — the fix is giving it the
  resolved shape the code already expects (e.g. `clientFetch(...)` is
  called with `.then(...)` right after mount; the fix is
  `mockResolvedValue({...})` with a shape matching what the real
  endpoint returns, not a new decision about what it *should* return).
- An AC's assertion is unreachable because an earlier guard in the same
  code path returns first (e.g. a required-field check runs before the
  behavior under test, so the AC's setup must satisfy that guard too).
- An AC leaves a value implicit that the code path actually branches on,
  making the test's outcome accidental rather than deliberate (give it
  the explicit value already implied by what the AC is trying to prove).
- An AC's own preconditions make its assertion vacuously true (e.g. it
  never reaches the branch it claims to test) — tighten the setup so the
  assertion is actually exercised.

**Judgment-requiring** (bounce as normal, spend no retries on it): the
verifier flags something with more than one defensible resolution, or
requiring information this run doesn't have — a design tradeoff, a
missing stakeholder decision, an architectural choice, anything the
skill's own philosophy (`## Role: the skeptic`) already reserves "for
the human gate, not a machine guess." If you notice yourself justifying
a fix with "I think probably," "the more scalable choice," or picking
between two approaches with real tradeoffs — that is judgment-requiring,
even if it feels small. Bounce it exactly as Steps elsewhere in this
skill already do.

**Mechanics of a self-heal cycle**: fix the specific gap the verifier
named, nothing else (do not re-open sections that already passed), then
re-run the verifier subagent — a fresh independent check, not a
self-assessment that the fix worked. Cap at **4 cycles** per run. If a
mechanical-looking failure is still unresolved after 4 cycles, stop
self-healing and bounce it as `spec_ambiguous` with all 4 attempts and
findings as evidence — that many unresolved "mechanical" fixes is itself
a signal the classification was wrong, or the ticket has a deeper problem
than any single AC.

Log each self-heal cycle to `progress.jsonl` distinctly from a bounce —
a `"phase": "verify"`, `"event": "note"` line whose `detail` starts with
`"self-heal cycle <n>:"` naming the specific gap and fix, so a run that
took 4 internal cycles is distinguishable at a glance from one that
passed clean on the first attempt. The finalized `Refined Spec` comment
and `verdict.json`'s `detail` should also note the cycle count in one
clause (e.g. "ready — refined ticket written (after 4 fix/re-verify
cycles)") — this is signal for anyone reading the ticket or the run
later, not just internal bookkeeping.

## Cleanup (hard gate, every run)

Before this skill's final result line — regardless of outcome (ready,
bounced at any step, or error):

1. **If you started the target repo's dev server during Ground, stop it.**
   Confirm it's actually stopped (e.g. the port is free), not just that you
   sent a stop signal.
2. **Remove this run's worktree**:
   `git -C <targetRepo.path or .pipeline/<SLUG>/repo, whichever it was
   created from> worktree remove
   <that checkout's path>/.claude/worktrees/<TICKET>-<RUN_ID>-ground`. Since this
   skill never commits, there is no "uncommitted work worth keeping"
   exception here (unlike `ticket-to-pr` — see its own Cleanup section) —
   always remove it.

Both apply even if you never reached Ground (nothing to clean up, but check
before assuming so) and even if the run is about to bounce or error out.
This is not conditional on how the run concludes.

## Definition-of-ready checklist (enforced, not vibed)

0. The `Refined Spec — ready for ticket-to-pr` comment exists and follows
   the official template: `### Overview`, `### Acceptance Criteria`,
   `### Scope` present and populated.
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
7. No raw secret/credential/token/password value anywhere in the draft —
   see Ticket content protocol item 6. Presence/shape references
   (`hasClientSecret: true`, a var name alone) are fine; a raw value is
   not, regardless of which step surfaced it.

## Ticket content protocol

**This skill never writes to the Jira description field.** Tickets are
authored by many different stakeholders in many different styles;
normalizing or overwriting someone else's ticket into our house format is
bad practice regardless of how good the result is. The original
description stays exactly as written, permanently — it's the fast,
human-skimmable "what is this ticket about" view.

1. All work-in-progress — interpretation notes, recon findings, assumption
   attacks, iteration updates — flows through **working comments** during
   the run. The description is never used as a scratchpad, and never
   rewritten.
2. Only on a passing verdict does this skill write **one comment**, titled
   exactly `Refined Spec — ready for ticket-to-pr`, in the fixed template:
   - `### Overview` — problem statement, verified context, fault domain
     (for bugs), surviving assumptions (labeled as assumptions)
   - `### Acceptance Criteria` — TDD-ready: each AC names its test, what it
     asserts, why it fails on current code
   - `### Scope` — files/modules to touch, size estimate,
     sequencing/follow-up drafts if split
3. On re-pickup (an existing `Refined Spec — ready for ticket-to-pr`
   comment found, ticket sent back with a human steering comment): update
   that same comment in place rather than creating a second one each
   cycle.
4. The Step 7 verifier checks this comment's content and format — a
   refined ticket without these sections, or without this comment at all,
   is not ready by definition.
5. **Never write an absolute filesystem path into any Jira comment** —
   this machine's home directory is an email address, so an absolute path
   leaks PII into Jira. Refer to files by repo-relative path only (e.g.
   `src/client/App.jsx`, not
   `/Users/<email>/Desktop/repo/src/client/App.jsx`).
6. **Never write a raw env var value, `.envrc`/`.env` file content, or any
   credential/token/key/password value into a Jira comment,
   `progress.jsonl` note, or the always-emitted result line** — Ground's
   worktree lives inside the target repo's own directory tree specifically
   so `direnv` picks up its real local env (see "Target repo (grounding)"
   above), which means that env can contain real secrets. To demonstrate a
   var is set (e.g. confirming a dev-server dependency has credentials
   available), report name/presence/length only — imitate the target
   repo's own `hasClientSecret`/`clientSecretLength`-style logging, never
   the raw value itself. This applies to `recon-agent` and
   `devils-advocate-agent` findings quoted into a comment just as much as
   to this skill's own writing. **This rule now has a code-level backstop**
   — a `PreToolUse` hook (`.claude/hooks/block-secret-comments.sh`) denies
   any Jira/Confluence write whose content matches a known secret name or
   format pattern (see `CHANGELOG.md`'s "Round 2" entry) — but that hook is
   a heuristic backstop, not a replacement for following this rule; it
   won't catch every shape a secret could take.

## Bouncing (any step)

A bounce is a normal, successful exit — not a crash. On any bounce:

1. Run Cleanup (see above) — it applies regardless of why this run is
   ending; a bounce is not an exception to it.
2. Write **one comment** (never the description), titled exactly
   `Ticket-Refine Bounce — <failure_category>` (e.g.
   `Ticket-Refine Bounce — blocked`) — greppable and consistent the same
   way `Refined Spec — ready for ticket-to-pr` is for a passing verdict.
   Open the comment body with this fixed three-line header, then the
   evidence free-form below it (evidence genuinely varies by category —
   a `blocked` bounce and a `spec_contradicted` bounce don't look alike,
   and forcing them into one shape would lose signal):
   ```
   **Verdict:** bounced (`<failure_category>`)
   **Summary:** <one sentence — what's wrong, in plain language>
   **Needs from you:** <one sentence — the specific decision or action
     that unblocks this ticket, e.g. "approve the drafted split," "decide
     assertion strategy A or B," "confirm this should be filed against
     the Critics service">
   ---
   <free-form evidence: file paths, what was found vs. claimed, the
   specific ambiguous readings, the suggested split, drafted follow-up
   tickets, etc.>
   ```
   On re-pickup after a bounce, find and update this same comment (same
   title convention as the `Refined Spec` comment) rather than posting a
   second one each cycle.
3. Write `verdict.json` with `outcome: "bounced"`, the step you stopped at
   as `phase_reached` (use the closest match: `triage`→`intake`,
   `interpret`/`ground`/`attack`→`plan`, `scope`/`blocked-check`→`plan`,
   `synthesize`→`red`, `verify`→`verify` — the loop's `PhaseReached` enum
   is shared across both skills, so map onto its nearest equivalent), a
   `failure_category` from the closed enum, and a `detail` string with the
   concrete evidence.
4. Emit the always-emitted result line and stop.

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
  "model": "sonnet",
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
claude -p "/ticket-refine <TICKET-KEY>" --model sonnet --permission-mode acceptEdits --output-format json
```

`--model sonnet` is explicit, not ambient-default. This skill originally ran
on `--model opus` for its own judgment calls (Interpret, synthesizing
Attack's findings, Scope, Synthesize), but in practice the *entire* session
— Triage, Ground's bookkeeping, every intermediate turn — paid Opus pricing
too, since a single continuous `claude -p` session bills every turn at one
model tier, not just the turns that need deep reasoning. That drove real
cost (Cost Tier Mix / Cost Economy) without a corresponding way to scope
Opus to just the four steps that needed it short of a larger re-architecture
(splitting into a Sonnet-tier orchestrator that calls out to Opus only for
specific steps). Switched to Sonnet for the whole session as the simpler
fix; if bounce/synthesis judgment quality visibly degrades on real tickets,
revisit — either back to Opus, or the split-orchestrator design. The
subagents it spawns (`recon-agent`, `devils-advocate-agent`,
`verifier-agent`) each pin their own model in their frontmatter regardless
of this invocation's tier. See `docs/skills.md` for the per-subagent model
rationale.
