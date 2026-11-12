#!/bin/bash
# block-non-eval-jira-writes.sh — PreToolUse hook, the eval boundary
# (Task 16, spec §9.2). Inactive unless DEVLOOP_EVAL_KEYS is set, which only
# `evals/run.sh` does (to the comma-separated keys it created). While set,
# it denies any mcp__atlassian__ write whose issue key is not in that list:
# addCommentToJiraIssue, editJiraIssue, transitionJiraIssue,
# addWorklogToJiraIssue (issueIdOrKey / issueKey), createIssueLink (both
# ends), createJiraIssue (allowed only with a `[dev-loop-eval]` summary),
# and every other atlassian tool that is not a known read. Reads are always
# allowed. Rules live in scripts/check-eval-jira-write-in-tool-input.ts.
#
# Exit-code contract with the checker, same as the sibling hooks:
#   0 -- allowed                                   -> hook exit 0
#   3 -- denied by a rule                          -> hook exit 2
#   2 -- the check failed (bad stdin, bad module)  -> hook exit 2
#   anything else (checker crashed/unrunnable)     -> hook exit 2
#
# Fail-closed while active: a denied write is a clear signal the run can
# report; a write to a real non-eval ticket is not recoverable.
#
# The untrusted tool_input JSON reaches the checker via stdin only.

set -u

# Inactive: not an eval run. (Set but empty is active: no key is listed.)
if [ -z "${DEVLOOP_EVAL_KEYS+set}" ]; then
  exit 0
fi

INPUT=$(cat)

HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P) || HOOK_DIR=""
CHECKER="${HOOK_DIR:-/nonexistent}/../../scripts/check-eval-jira-write-in-tool-input.ts"

EXIT_CODE=2
if [ -f "$CHECKER" ]; then
  printf '%s' "$INPUT" | node "$CHECKER" 2>/dev/null
  EXIT_CODE=$?
fi

case "$EXIT_CODE" in
  0)
    exit 0
    ;;
  3)
    echo "BLOCKED: this is an eval run (DEVLOOP_EVAL_KEYS is set) and this Jira write targets a ticket that is not one of the eval's own keys (or is a create without the [dev-loop-eval] summary prefix, or an atlassian write this hook does not know). Eval runs may only write to their own tickets. Report this instead of retrying." >&2
    exit 2
    ;;
  *)
    echo "BLOCKED: could not verify this Jira call stays inside the eval's tickets (the check itself failed to run, or the input was malformed) while DEVLOOP_EVAL_KEYS is set -- denying." >&2
    exit 2
    ;;
esac
