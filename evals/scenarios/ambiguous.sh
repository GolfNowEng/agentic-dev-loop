#!/usr/bin/env bash
# Scenario `ambiguous` (sourced by evals/run.sh): a ticket research must
# bounce. Expect: research bounced, the ticket in Blocked, 1 phase, no PR
# (graded by evals/check-ambiguous.mjs).

setup() {
  local f
  f=$(describe ambiguous <<'TXT'
Make durations nicer.

Users have said the duration handling is confusing. Make toMs friendlier and support the formats people actually use. It should also be faster.

Acceptance criteria:
1. Durations work the way users expect.
2. It is better than before.
TXT
)
  new_ticket "$EVAL_PREFIX make durations nicer" "$f" --trigger
  KEYS="$NEW_KEY"
  LOOPS=1
  GRADE_ARGS="--keys=$NEW_KEY"
}
