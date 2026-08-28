# Future Enhancements

Ideas for the pipeline itself (not tickets it processes) that are worth
doing but not yet drafted into a change. Unlike `CHANGELOG.md` (landed
fixes), this is a holding pen — write down the idea and the evidence that
motivated it, then leave it for later. When one of these actually gets
implemented, move its entry to `CHANGELOG.md` and delete it from here.

## Cheap-tier gate for test-only tickets (Step 0, ticket-refine)

**Idea**: add a triage-time check in `ticket-refine`'s Step 0 (Triage &
route) that recognizes a narrow ticket class — new test coverage only,
zero application-code changes, no new runtime behavior — and runs a
lighter pipeline for it: skip or shrink Attack's empirical
build-and-run-a-scratch-test step, and rely on Verify's static check
instead. Everything else (Ground's currency check, Synthesize, Verify)
stays as-is; this is scoped to the one most expensive step for the one
lowest-risk ticket class.

**Why**: on `TARS-1284` (add ~8 new tests to one new file, no changes to
`FormReviews.jsx` itself), the full run took ~47 minutes wall-clock. Of
that, Attack alone took ~13 minutes because `devils-advocate-agent`
built and ran a real scratch integration test to verify a test-file
mocking pattern. That's the right level of scrutiny for a ticket that
could break production behavior — but this ticket touched no production
code at all, so the blast radius of being slightly wrong is much smaller
than what Attack's cost is calibrated for. See `progress.jsonl` in
`.pipeline/webtarsthree/runs/TARS-1284-20260827T225552Z/` for the phase
timestamps this estimate is based on.

**Not yet scoped**: exact detection rule for "test-only ticket" (likely:
Scope's own files-to-touch enumeration, checked *before* Attack rather
than after); how much to shrink Attack (skip entirely vs. drop just the
empirical-build sub-step); whether this should be a new Step 0 branch or
a flag Ground/Attack read.
