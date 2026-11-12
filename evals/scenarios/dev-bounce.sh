#!/usr/bin/env bash
# Scenario `dev-bounce` (sourced by evals/run.sh): a ticket whose
# description reads as complete, but whose one decisive value is only
# defined by a referenced document that does not exist in the repo, so the
# executor cannot reason to it from the ticket. Expect: research landed,
# dev bounced with spec_ambiguous (graded by evals/check-dev-bounce.mjs).
# This is the least deterministic scenario: research may bounce it first.

setup() {
  local f
  f=$(describe dev-bounce <<'TXT'
Add a slugify length limit.

In app modules/slug.js, slugify(text) gains an optional second argument, maxLength. When given, the returned slug is truncated to maxLength characters using the truncation rule agreed in the slug style guide (docs/slug-style.md in the app), and never ends with a hyphen. When omitted, behavior is unchanged.

Acceptance criteria:
1. slugify('Hello World') is unchanged ('hello-world').
2. slugify(text, maxLength) follows the style guide's truncation rule for word boundaries.
3. The result never ends with '-'.
4. Existing tests still pass (the package test script).
TXT
)
  new_ticket "$EVAL_PREFIX slugify length limit" "$f" --trigger
  KEYS="$NEW_KEY"
  LOOPS=1
  GRADE_ARGS="--keys=$NEW_KEY"
}
