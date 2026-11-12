#!/usr/bin/env bash
# Scenario `queue` (sourced by evals/run.sh): two tickets created in order,
# the first ambiguous and the second clean. The research poll orders by
# created, so iteration 1 bounces the first (it leaves To Do) and
# iteration 2 lands the second. Expect: two records, the second landed
# (graded by evals/check-queue.mjs).

setup() {
  local f1 f2 first
  f1=$(describe queue-1 <<'TXT'
Improve the registry.

The registry should be more useful. Make it better for the team.

Acceptance criteria:
1. The registry is improved.
TXT
)
  new_ticket "$EVAL_PREFIX improve the registry" "$f1" --trigger
  first=$NEW_KEY
  f2=$(describe queue-2 <<'TXT'
Add a clampPercent helper.

In app modules/clamp.js, export clampPercent(n) that returns clamp(n, 0, 100). Add 'clampPercent' to registry.js directly above the ANCHOR comment.

Acceptance criteria:
1. clampPercent(-1) returns 0.
2. clampPercent(42) returns 42.
3. clampPercent(250) returns 100.
4. Existing tests still pass (the package test script).
TXT
)
  new_ticket "$EVAL_PREFIX clampPercent helper" "$f2" --trigger
  KEYS="$first $NEW_KEY"
  LOOPS=2
  GRADE_ARGS="--keys=$first,$NEW_KEY"
}
