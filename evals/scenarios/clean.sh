#!/usr/bin/env bash
# Scenario `clean` (sourced by evals/run.sh): one well-specified ticket.
# Expect: research landed -> dev landed in one iteration, a sandbox PR open
# with the RED commit before GREEN (graded by evals/check-clean.mjs).

setup() {
  local f
  f=$(describe clean <<'TXT'
Add a clamp01 helper to the sandbox app.

In app modules/clamp.js, export a new function clamp01(n) that returns clamp(n, 0, 1). Re-export it from index.js (index.js already re-exports everything in modules/clamp.js, so no change there is needed) and add 'clamp01' to the registry in registry.js, on a new line directly above the ANCHOR comment.

Acceptance criteria:
1. clamp01(-0.5) returns 0.
2. clamp01(0.25) returns 0.25.
3. clamp01(7) returns 1.
4. registry includes 'clamp01'.
5. The existing tests in test/seed.test.js still pass (the package test script).

Out of scope: any change to clamp itself.
TXT
)
  new_ticket "$EVAL_PREFIX clamp01 helper" "$f" --trigger
  KEYS="$NEW_KEY"
  LOOPS=1
  GRADE_ARGS="--keys=$NEW_KEY"
}
