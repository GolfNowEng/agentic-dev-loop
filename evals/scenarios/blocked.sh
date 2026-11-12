#!/usr/bin/env bash
# Scenario `blocked` (sourced by evals/run.sh): ticket B "is blocked by"
# ticket A, and A has an open (unmerged) sandbox PR. A has no trigger label,
# so the loop never works it. Expect: B's record is skipped-blocked naming
# A, no claim, B still To Do (graded by evals/check-blocked.mjs).
#
# A's PR is made with the GitHub API on the sandbox only (api() is pinned
# to it): a branch off master plus one file, no git push.

setup() {
  local fa fb blocker sha branch
  fa=$(describe blocked-blocker <<'TXT'
Blocker ticket for the dev-loop eval `blocked` scenario. Its sandbox PR is left open on purpose. Do not work this ticket.
TXT
)
  new_ticket "$EVAL_PREFIX blocker (do not work)" "$fa"
  blocker=$NEW_KEY

  assert_repo "$EVAL_REPO"
  sha=$(api GET "git/ref/heads/master" --jq .object.sha) || return 1
  is_dry && sha=DRYSHA
  branch="$blocker-eval-blocker"
  api POST "git/refs" -f "ref=refs/heads/$branch" -f "sha=$sha" >/dev/null || return 1
  api PUT "contents/eval-blocker.txt" -f "message=chore($blocker): eval blocker placeholder" \
    -f "content=$(printf 'eval blocker\n' | base64)" -f "branch=$branch" >/dev/null || return 1
  api POST "pulls" -f "title=[dev-loop-eval] $blocker blocker (leave open)" -f "head=$branch" -f "base=master" \
    -f "body=Open on purpose: blocks the eval ticket. Synthetic content only." >/dev/null || return 1

  fb=$(describe blocked <<'TXT'
Add a clampInt helper.

In app modules/clamp.js, export clampInt(n, min, max) that returns Math.round(clamp(n, min, max)). Add 'clampInt' to registry.js directly above the ANCHOR comment.

Acceptance criteria:
1. clampInt(2.6, 0, 10) returns 3.
2. clampInt(-4, 0, 10) returns 0.
3. Existing tests still pass (the package test script).
TXT
)
  new_ticket "$EVAL_PREFIX clampInt helper" "$fb" --trigger
  jira link-blocks "$blocker" "$NEW_KEY" || return 1
  KEYS="$blocker $NEW_KEY"
  LOOPS=1
  GRADE_ARGS="--keys=$NEW_KEY --blocker=$blocker"
}
