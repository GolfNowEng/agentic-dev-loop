# Spec: Part 3 (consolidated size score) + Part 4 (post-merge-failure checklist additions)

**Revision 2** — rewritten after a 3-seat adversarial review (logic-
consistency, runtime-risk, security) found 5 critical and 10 major issues
in Revision 1. Every finding below is closed in this revision; see
"Changes from Revision 1" at the end for a flat diff against what the
review actually flagged, so nothing was silently dropped.

Context: research-loop is "Terminal A / the skeptic" in a two-repo agentic
Jira pipeline (sibling: dev-loop, "Terminal B / the executor"). CLAUDE.md
requires TDD (test first, `npm test` green before/after) for any change to
`src/`. Parts 1-2 of this same initiative already landed (Jira comment
format unification, AC-grouping clarification in the sibling `skills`
repo) after their own adversarial-review pass.

## Problem being solved

`verifier-agent.md`'s definition-of-ready checklist has two redundant,
inconsistent size checks:
- item 4: qualitative "does this read as small/medium" judgment call.
- item 8: flat "~10 behavior ACs" threshold for an advisory `too_large`
  signal.

Real evidence these conflict: TARS-1554 bounced `too_large` at 11 flat
ACs. TARS-1565 PASSED at 13 ACs (its own Scope section self-justified
this as "comparable to TARS-1554's scope, within bound"). Same checklist,
two different thresholds depending on which item's judgment call fired
first, and the self-justification in TARS-1565 shows Synthesize grading
its own scope claim.

Separately: real post-merge GitHub Copilot review on these same two
tickets' PRs found 8 real issues that neither `devils-advocate-agent`
(spec-time attack) nor dev-loop's `qa-agent` (implementation-time QA)
caught: unbounded custom-size memory/canvas allocation (~400MB), PNG
alpha-channel loss on a format conversion, a test whose correctness
depended on `origin/master` state (flaky outside CI's exact setup),
unmemoized re-renders, a dynamic status message missing `role="alert"`,
and two responsive-breakpoint bugs. These were caught by a reviewer nobody
budgeted for catching them, after merge.

## Part 3: consolidated size score

### Schema changes (`src/types.ts`, `src/verdict.ts`, `src/runs-log.ts`, `src/loop-runner.ts`) — TDD required per CLAUDE.md

```ts
export const CURRENT_LOG_VERSION = "1.1";

export type TShirtSize = "S" | "M" | "L" | "XL";
export type SizeDelta = "grew" | "shrank" | "unchanged";

export interface SizeTrajectory {
  step4_tshirt: TShirtSize;
  final_score: number; // always in [0, 10]
  delta: SizeDelta;
}

// Verdict and RunLogLine both gain:
log_version?: string;
size_trajectory?: SizeTrajectory;
```

- Old runs have neither field (implicitly "1.0" by absence/convention —
  no backfill). New runs stamp `log_version: "1.1"` on `verdict.json`,
  and once on the first `phase_start` event of a run's `progress.jsonl`
  (not every line — each run already gets its own fresh file).
- Carrying `size_trajectory` from `Verdict` into `RunLogLine` is
  `src/loop-runner.ts`'s job (same place `verify_loops` is already copied
  across today) — not a new consumer, just one more field in that
  existing mapping. **`scripts/stats.mjs` is explicitly out of scope for
  this change** — it does not learn to read `size_trajectory` or
  `log_version`; the Checkpoint report (below) is a separate, one-off
  script, not an addition to `npm run stats`. Avoids scope creep into a
  second reporting surface this spec doesn't need.
- **Validation is split into two independent paths — this is the fix for
  Revision 1's critical shadow-mode contradiction.** `isValidVerdictShape`
  continues to validate only the core `Verdict` fields it validates today
  (`outcome`, `phase_reached`, `failure_category`, `detail`) and is
  **unaware of `size_trajectory` entirely** — a verdict with no
  `size_trajectory`, or a syntactically-present-but-malformed one, is
  still a structurally valid `Verdict` as far as this function is
  concerned. A **separate** function, `parseSizeTrajectory(value:
  unknown): SizeTrajectory | null`, validates `size_trajectory` on its
  own: `step4_tshirt` must be one of the 4 literal values, `delta` one of
  the 3, `final_score` a finite number with `0 <= final_score <= 10`. On
  any failure it returns `null` and the caller logs a warning (e.g. to
  `progress.jsonl` or stderr) — **it never flips `outcome` to `"error"`,
  in shadow mode or after promotion**. This guarantees a malformed
  trajectory can never turn a passing/bounced run into an error run,
  which is the actual invariant "never affects the verdict" needs, stated
  as code rather than as a mode-dependent exception.
- Any future replay/stats code branches on `line.log_version ?? "1.0"` —
  never infers version from field presence/absence.
- Tests first (`test/verdict.test.ts`): old-shape verdict parses
  unchanged via `isValidVerdictShape`; a verdict with `size_trajectory`
  present still parses via `isValidVerdictShape` regardless of whether
  the trajectory itself is well- or malformed (proving the two paths are
  independent); `parseSizeTrajectory` separately: accepts a valid
  trajectory, rejects a bad enum value, rejects a non-finite or
  out-of-range `final_score`, all by returning `null`, never throwing.

### Two measurement points (shadow-mode trajectory, not a single number)

- **Step 4 (Scope & sequence)**, in `ticket-refine/SKILL.md` itself (not
  a subagent step) — already makes an implicit oversized/not judgment
  call today. Newly: record that judgment as an explicit t-shirt size
  (`S`/`M`/`L`/`XL`) as a `progress.jsonl` note, every run, regardless of
  whether this step bounces `too_large`.
- **Step 7 (Verify)** — `verifier-agent` computes the numeric score below
  on every pass (including each self-heal re-check) and **reports it as
  part of its structured output to `ticket-refine`** — it does not write
  `verdict.json` itself; per the existing contract (`SKILL.md`'s
  `verdict.json` schema, `docs/skills.md`'s "verdict.json contract"),
  only `ticket-refine` ever writes that file. On the *final* pass of the
  run, `ticket-refine`'s own Step 7 takes the score `verifier-agent`
  reported and writes `size_trajectory` into `verdict.json`:
  `step4_tshirt` from Step 4's note, `final_score` from that last
  verifier pass, `delta` from the fixed t-shirt/score mapping below.
  **This corrects Revision 1's ownership error**, which had
  `verifier-agent` writing `verdict.json` directly — something neither
  its own Output contract nor `SKILL.md` has ever had it do.

Rationale: this turns "does the new formula reproduce old pass/bounce
outcomes" (circular — those outcomes were produced by the exact
heuristic being replaced) into "does the score move the way we'd expect
across a run, and does a ticket that was always oversized look different
from one that grew during self-heal" — an actual signal, observable only
by tracking two points over time, not a single final value.

**Fixed t-shirt/score mapping** (closes Revision 1's "delta is
undefined" major finding):

| Score range | T-shirt |
|---|---|
| `[0, 2.5)` | S |
| `[2.5, 5)` | M |
| `[5, 7.5)` | L |
| `[7.5, 10]` | XL |

`delta` compares ordinals (`S=0, M=1, L=2, XL=3`): the score-derived
ordinal vs. Step 4's `step4_tshirt` ordinal. Higher -> `"grew"`, lower ->
`"shrank"`, equal -> `"unchanged"`.

### The score — computed by `verifier-agent`, cross-checked against Ground's own findings

Four dimensions. All four are **mechanical counts, not judgment calls** —
`verifier-agent` is already in the business of grepping/counting rather
than inferring (see its existing items 1-3), so this stays consistent
with that style and keeps the per-pass cost to a count, not fresh
reasoning:

1. **Parent AC count** — count of top-level AC bullets in
   `draft-spec.md`, defined mechanically so two implementers can't
   disagree: a line beginning with `- ` at zero indentation under `###
   Acceptance Criteria` is a parent bullet (a bold-named parent, `- **Name**:
   ...`, still counts as exactly one, regardless of how many indented
   children follow); a line indented under it (`  - ...`) is a child and
   never counts on its own. This matches the `jira-create-ticket` Story
   template's parent/child convention from Part 1 — grouping is for
   scanning clarity, parent bullets are what's counted.
2. **Distinct files touched** — count of file paths enumerated in the
   `### Scope` section (already required present by existing item 2;
   this reuses that same enumeration).
3. **Distinct subsystems touched** — derived mechanically from the same
   Scope file list: the first path segment under `src/`/`app/` if the
   path has one of those prefixes; otherwise the file's first path
   segment as given (e.g. `scripts/foo.ts` -> `scripts`); a path with no
   separator at all (a repo-root file) counts as subsystem `root`. A
   non-empty Scope file list (already enforced by existing checklist item
   2) always yields at least one subsystem — there is no zero-files,
   nonzero-subsystems case to handle, and a zero-files Scope already fails
   item 2 before this dimension is ever reached.
4. **Self-heal AC growth** — final parent-AC count minus the parent-AC
   count recorded at this run's *first* Step 7 attempt. To make this
   actually computable (Revision 1 said "read from progress.jsonl's own
   self-heal notes" without those notes carrying a count — closing that
   gap here): **every** verify-phase pass, not just self-heal cycles,
   appends one `progress.jsonl` note with a fixed, machine-parseable
   `detail` format:
   ```
   "verify pass <n>: parentAC=<count> files=<count> subsystems=<count> score=<score>"
   ```
   `growth` = this run's **last** pass's `parentAC` minus its **first**
   pass's `parentAC`, both read directly from these notes — no new JSON
   field needed, since `progress.jsonl`'s existing `detail` is already a
   free-text string and this is just a fixed convention for its content,
   consistent with the existing `"self-heal cycle <n>: ..."` convention.
   A negative growth value (self-heal *removed* ACs) is floored at 0 by
   the formula below, not treated as negative size.

```
score_0_10 = 10 * (
    0.35 * clamp01(parentAC / 15)
  + 0.25 * clamp01(files / 10)
  + 0.25 * clamp01(subsystems / 4)
  + 0.15 * clamp01(max(growth, 0) / 3)
)
```

where `clamp01(x) = max(0, min(x, 1))` — **closes Revision 1's unclamped-
formula major finding**: every term is bounded to `[0, 1]` before
weighting, `growth` is floored at 0 before the ratio, so `score_0_10` is
always in `[0, 10]`, never negative, regardless of input.

Weights and the per-dimension ceilings (15 ACs, 10 files, 4 subsystems, 3
AC-growth) are a reasoned provisional default — explicitly not tuned to
reproduce historical bounce/pass outcomes.

### Fixing the self-grading problem for real (closes Revision 1's critical finding #4)

Revision 1 computed dimensions 2/3 from the Scope section's own file
list — which fixed *who does the arithmetic* (verifier, not Synthesize)
but not *whose claim the arithmetic trusts* (still Synthesize's list,
authored from the same reasoning being graded). Fix: when `ticket-refine`
spawns `verifier-agent` for Step 7, it now also passes along **the set of
files/areas `recon-agent` actually found relevant during Ground** — this
is not new work, since `ticket-refine`'s own session already holds
Ground's results from Step 2 (recon-agent findings are already read
before Attack/Synthesize ever run) — it's just forwarded into the Step 7
subagent prompt that wasn't receiving it before. `verifier-agent` runs a
**plausibility check**, not a second independent investigation: if
Scope's enumerated file list is implausibly narrow relative to what
Ground actually found touching the described behavior (e.g. Ground's
recon identified three call sites with the same bug pattern, but Scope
names only one file) — that's a new, explicit checklist failure
(`Scope/Ground mismatch`), reported with the specific discrepancy, same
severity as any other checklist item. This is cheap (no new exploration,
no new subagent) and actually resists undercounting, rather than
re-stating the same unverified count more carefully.

### Validation path (replaces the circular "replay against ~40 historical runs" plan)

1. **One-time sanity check, not calibration**: run the score formula as
   a pure script (no LLM judgment involved) against historical runs'
   `draft-spec.md`/`progress.jsonl` where both exist, solely to catch
   arithmetic bugs (NaN, negative scores, a known-smaller ticket scoring
   higher than a known-bigger one). This does **not** tune weights to
   match old outcomes.
2. **Shadow mode** (the real validation): once Part 3 ships, every real
   run computes and logs `size_trajectory` via the independent validation
   path above, but **items 4 and 8 of the existing checklist remain the
   live, enforced gate, completely unchanged, for the entire shadow
   period** — closes Revision 1's major finding that "replaces items 4
   and 8 outright" contradicted shadow mode. The score affects nothing
   about the verdict during this window; it is pure telemetry.
   - **Window**: a run counts toward the shadow sample once it reaches
     Step 7 and produces a valid `size_trajectory` (re-pickup runs count
     individually — each is its own measurement of score behavior, not a
     duplicate). Minimum **10** such runs *and* **21** calendar days,
     whichever is reached **later** — not "whichever comes first." If 21
     days elapses with fewer than 10 qualifying runs, extend in 7-day
     increments until 10 is reached, rather than checkpointing on too
     small a sample. This closes Revision 1's major finding that the
     bound's unit/minimum sample size were undefined.
3. **Checkpoint**: once the window closes, produce a report of the
   collected trajectories (score distribution, grew/shrank/unchanged
   counts, where a candidate threshold would have landed on each) for an
   explicit human go/no-go before the score gates anything. This report
   is generated by a script reading `runs/<project>.jsonl` directly, not
   hand-assembled from raw Scope sections — and **must apply the same
   absolute-path and secret/credential redaction rules as `SKILL.md`'s
   existing Ticket content protocol items 7-8** before being shown to
   anyone, since it aggregates file-path data sourced from Scope sections
   across many runs (closes Revision 1's major finding that this new
   reporting surface wasn't covered by the existing redaction rules).
   Only if this checkpoint is approved does a **separate, later, its-own
   change** actually remove items 4/8's text from `verifier-agent.md`'s
   checklist and `SKILL.md`'s Definition-of-ready list and replace them
   with a single "size score below threshold T" item — that replacement
   commit is explicitly out of scope for what this spec authorizes; this
   spec only gets as far as the checkpoint. Whether the score, once
   promoted, also ever gates `autoPromoteLabel` is a separate, later
   decision not bundled into this checkpoint either.

### New cap: cross-run growth across re-pickup cycles

The existing in-run self-heal cap (4 cycles, mechanical fixes only, per
`SKILL.md`'s "Mechanics of a self-heal cycle") is untouched by this spec.
New and separate, and now an actual cap (closes Revision 1's major
finding that this section didn't enforce anything): Step 4 counts this
ticket's prior `RUN_DIR`s under `.pipeline/<slug>/runs/<TICKET>-*` before
concluding its oversized judgment. **On the 4th total run for the same
ticket key** (3 or more prior `RUN_DIR`s already exist), Step 4 computes
cumulative parent-AC growth across all those prior runs (first pass of
run 1 vs. last pass of the most recent prior run, from their
`progress.jsonl` verify-pass notes). **If that cumulative growth exceeds
5 parent ACs, Step 4 must bounce `too_large` right there**, citing the
full growth history as evidence, and does not proceed to a 5th automatic
run — a human who wants to force another cycle has to run `npm run
reset-project` (`docs/reset.md`) to clear this ticket's run history
first, which is already the existing deliberate mechanism for "start this
ticket fresh." Below that threshold, Step 4 proceeds as normal.

## Part 4: generalized post-merge-failure checklist additions

The 8 real Copilot findings from TARS-1554/1565 translated into general,
non-ticket-literal trigger conditions, split by which pipeline stage can
actually observe the condition — spec-time (`devils-advocate-agent`, no
real diff exists yet) vs. implementation-time (`qa-agent`, a real diff
and running app exist):

**`devils-advocate-agent.md`** additions (new attack angles 5-6, alongside
existing 1-4):

5. **Unbounded resource sizing** — flag when an AC implies an allocation
   (buffer, canvas, in-memory array/image) sized from user-controlled
   input, with no stated cap.
6. **Lossy transformation** — flag when an AC describes a format/encoding
   conversion with no statement of which attributes (alpha channel,
   metadata, numeric precision) must be preserved across it.

**Implementation note (closes Revision 1's major finding #8)**: this file
currently says, in multiple places, that it is "deliberately narrow to
four angles" and instructs the agent not to "hunt for a fifth angle
beyond the four above." Adding angles 5-6 is not a two-bullet append —
every one of those "four angles" references (the "What to attack" intro,
the narrowing rationale, the "What NOT to do" exploration-limit bullet,
and the Output section's "For each of the four angles above") must be
rewritten to six, and the rationale for *why* it's bounded to a fixed set
(judgeable from Interpret/Ground's existing findings, no new open-ended
exploration) must be re-stated to explicitly cover 5-6 too — both new
angles are, like the original four, judged from AC text and
Interpret/Ground's existing findings alone, not new codebase exploration,
so the existing rationale extends cleanly; it just needs to actually say
so. Angles 5-6 add no new exploration cost (same context, more angles
over it) — the token-cost concern raised in review is real but modest,
and not worth gating behind a keyword pre-filter that would itself need
maintenance.

**`qa-agent.md`** additions (new checklist items 6-9, alongside existing
1-5):

6. **Environment-dependent test correctness** — flag a new/changed test
   whose correctness depends on branch name, system clock, or CI-vs-local
   environment rather than being hermetic. Static/diff-read check, no
   extra browser pass.
7. **Re-render discipline** — flag a changed component that re-renders on
   every parent render with no memoization and no stated reason it's
   unnecessary. Assessed by reading the diff for missing
   `memo`/`useMemo`/`useCallback` around an otherwise-unnecessary
   re-render path — static/diff-read check, no extra browser pass.
8. **Dynamic feedback accessibility** — flag a dynamically-appearing
   status/error message with no `role="alert"`/`aria-live` equivalent.
   Static/diff-read check, no extra browser pass.
9. **Responsive breakpoint coverage** — flag a layout change checked at
   only one viewport width, not the project's defined breakpoints. **This
   is the one item that needs an extra browser pass**, so it's gated:
   only runs when the diff touches a layout/CSS file; when it does, one
   extra `qa-browser.ts` screenshot pass per defined breakpoint, not per
   component, closing the unconditional-cost finding from runtime-risk.

(Numbering above is corrected to match a straight 6-9 append onto
`qa-agent.md`'s existing 1-5, closing Revision 1's own internal
numbering mismatch, where the prose said "6-9" but the list was labeled
"7-10.")

### Eval methodology — held-out, sequential, cost-capped, dry-run

- **Held-out set**: 4 historical tickets, explicitly excluding
  TARS-1554/1565 (the tickets the new checklist items were written
  *from* — re-running against them would only prove the items catch what
  they were written to catch, not that they generalize), selected at
  eval-start time by this rule: from `.pipeline/webtarsthree/runs/`,
  pick tickets whose `RUN_DIR` reached `outcome: "ready"` **and** whose
  corresponding dev-loop PR is confirmed merged via `gh pr view <n>
  --json state,mergedAt`. The exact 4 keys are determined by actually
  running that check, not guessed in advance in this spec.
- **Dry-run only — closes Revision 1's critical finding #5.** Revision 1
  implicitly ran these subagents through their normal host skill
  (`ticket-refine`/`ticket-to-pr`), which is what actually posts
  Jira/GitHub comments — including the idempotent re-pickup path that
  **always posts a brand-new comment** on a ticket with a matching prior
  comment. Running the eval that way would post diagnostic noise to
  real, already-closed production tickets as a side effect. Fix: the
  eval invokes `devils-advocate-agent`/`qa-agent` **directly** via the
  `Agent` tool, standalone — not through `ticket-refine` or
  `ticket-to-pr` at all — constructing each subagent's normal inputs from
  that historical run's already-persisted artifacts (`draft-spec.md`,
  `progress.jsonl` for devils-advocate-agent's Interpret/Ground context;
  the historical merged PR's diff, checked out in a scratch worktree, for
  qa-agent). Findings are written to a local file for review. **Neither
  host skill is ever invoked, so neither skill's Jira/GitHub write path
  is ever reached** — no comment, no label, no transition, on any real
  ticket, for the entire eval.
- **Sequential execution only** — one held-out ticket's agent calls run
  to completion, and its scratch worktree is torn down and its dev
  server (if `qa-agent` started one) is confirmed stopped, before the
  next ticket starts. This avoids port/worktree collisions against the
  shared target-repo checkout.
- **Cost/time ceiling — concrete numbers, closing Revision 1's "TBD"
  critical finding**: **$15 total** and **90 minutes wall-clock total**
  across all 4 tickets, checked after each ticket completes — if either
  number would be exceeded by continuing, stop after the current ticket
  and report results for however many completed, rather than continuing
  past the cap. Real API spend for this eval is already pre-approved in
  principle; these numbers are the actual bound on that approval, not a
  placeholder.
- **Success criterion, with adjudication defined** (closes Revision 1's
  major finding that "non-false-positive" had no decision rule): a
  flagged finding is adjudicated by you (Justin) reading it against the
  real merged diff and judging whether it names a genuine issue that
  wasn't already caught by an existing check on that same run — there is
  no Copilot-review oracle for these held-out tickets (unlike
  1554/1565), so this is necessarily a human judgment call, made
  explicit rather than left implicit. At least one adjudicated-real
  finding across the 4 tickets counts as evidence of value. Zero across
  all 4 is a valid, reportable "no evidence from this sample" outcome,
  not grounds to keep enlarging the sample.

Part 3 and Part 4 ship and get verified as fully separate changes from
each other (standing rollout decision from earlier in this initiative) —
any bounce-rate or quality shift after either lands can be attributed to
the correct one.

## Rollout / landing constraints

- **Split by repo and file, explicitly** (closes Revision 1's minor
  finding that this wasn't spelled out): Part 3 (schema + `SKILL.md` +
  `verifier-agent.md` changes) lands entirely in **research-loop**. Part
  4 splits across both repos in **two separate commits**:
  `devils-advocate-agent.md` lands in **research-loop**; `qa-agent.md`
  lands in **dev-loop**. All as direct commits to local `main`, no
  feature branch, no PR — but no push to any remote without being asked
  (standing decision, unchanged).
- **Lightweight self-review gate before committing, trust-boundary files
  only** (closes Revision 1's minor finding on no-review-step risk for
  validation/trust-boundary code): before committing changes to
  `src/verdict.ts`, `src/types.ts`'s `Verdict`/`Config` shapes, or any
  `.claude/agents/*.md` file, do one explicit read-through of the diff
  specifically checking that no validation got quietly loosened and no
  checklist item got quietly weakened — noted as done, even without a
  formal PR, since no second reviewer exists in a direct-to-main flow.
- Real API spend for Part 4's held-out eval is pre-approved, bounded by
  the $15 / 90-minute ceiling above.
- **Docs to update alongside the code** (closes Revision 1's minor
  finding that doc files weren't in the change set): `docs/logging.md`
  (new `progress.jsonl` verify-pass note convention, `log_version`),
  `docs/skills.md` ("verdict.json contract" section, Definition-of-ready
  checklist section once items 4/8 are eventually replaced post-
  checkpoint — not in this change, but flagged for that later one), and
  `SKILL.md`'s own `verdict.json` schema block and progress-event list.
- **TDD gate applies to every `src/` file this touches**, per CLAUDE.md:
  `src/types.ts`, `src/verdict.ts`, `src/runs-log.ts`/`src/loop-runner.ts`
  (wherever the `Verdict` -> `RunLogLine` mapping lives) — tests written
  first, `npm test` red before the implementation, green after, for each.

## Changes from Revision 1 (flat diff against the review findings)

- Critical #1 (shadow-mode/validation contradiction) -> split
  `isValidVerdictShape` from a new, independent `parseSizeTrajectory`
  that never flips `outcome`.
- Critical #2 (cross-run "cap" wasn't a cap) -> concrete 5-AC threshold,
  forced `too_large` bounce, `reset-project` as the explicit override
  path.
- Critical #3 (eval cost ceiling TBD) -> $15 / 90 minutes, checked after
  every ticket.
- Critical #4 (self-grading moved, not fixed) -> verifier now receives
  Ground's own findings and runs a Scope/Ground plausibility check.
- Critical #5 (eval could write to live tickets) -> eval invokes
  subagents directly, bypassing both host skills' write paths entirely.
- Major #6 (items 4/8 "replaced outright" vs. shadow mode) -> explicit:
  items 4/8 stay live and unchanged through the entire shadow window.
- Major #7 (verifier doesn't own `verdict.json`) -> verifier reports the
  score to `ticket-refine`; `ticket-refine`'s Step 7 writes it.
- Major #8 (devils-advocate-agent's own "four angles" text) -> explicit
  implementation note to rewrite every such reference to six.
- Major #9 (growth dimension unrecordable) -> fixed, parseable
  `progress.jsonl` note format on every verify pass.
- Major #10 (unclamped/negative score) -> `clamp01` per term, `growth`
  floored at 0.
- Major #11 (delta/t-shirt mapping undefined) -> explicit score-range
  table.
- Major #12 (shadow-mode bound unit/minimum undefined) -> defined unit
  (qualifying runs), minimum 10, "later of" instead of "first of."
- Major #13 (success-criterion adjudication undefined) -> explicit
  human-adjudication rule stated.
- Major #14 (checkpoint report redaction undefined) -> extends existing
  Ticket content protocol items 7-8 to the checkpoint report.
- Major #15 (qa-agent items run unconditionally on every ticket) ->
  items 6-8 are static/diff-read (cheap, unconditional is fine); item 9
  (the expensive one) gated on diff touching layout/CSS.
- Minors #16-25 — all addressed above (self-review gate, `final_score`
  bound check folded into `parseSizeTrajectory`, docs list, mechanical
  parent-AC rule, subsystem fallback rule, per-pass score recording via
  the same fixed note format, held-out selection rule, numbering fixed,
  rollout split by repo, TDD gate scope stated).
