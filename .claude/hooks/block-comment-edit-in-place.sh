#!/bin/bash
# block-comment-edit-in-place.sh — PreToolUse hook denying any Jira/GitHub
# comment write that edits an existing comment in place, rather than
# creating a new one.
#
# Root cause this backstops (TARS-1450, 2026-09-19, see CHANGELOG.md):
# Jira and GitHub both render comment threads in creation-time order, not
# edit order. `ticket-refine`'s prior "idempotent re-refinement" convention
# edited the same tracked comment in place across every re-verify/re-pickup
# cycle, so the newest pipeline state stayed pinned at its original
# (often much earlier) creation-time position while newer human replies
# landed below it -- Jira and GitHub looked out of sync even though the
# underlying state was internally consistent. SKILL.md's prose now says
# "always post a new comment"; this hook is the real code-level backstop
# behind that prose, not a replacement for it -- see
# `.claude/hooks/block-secret-comments.sh` for the sibling pattern this
# follows.
#
# Denies (exit 2) two shapes:
#   - mcp__atlassian__addCommentToJiraIssue called with a non-empty
#     commentId (that parameter is what turns "create" into "update in
#     place").
#   - A Bash call that PATCHes an existing GitHub issue comment
#     (`gh api .../issues/comments/<id> ... -X PATCH` / `--method PATCH`)
#     or uses `gh issue comment --edit-last`.
#
# Same exit-code contract as check-secret-in-tool-input.ts (note: NOT the
# same as decideExitCode()'s internal 0|1|2):
#   0 -- clean, not an edit-in-place call                    -> hook exit 0 (allow)
#   3 -- edit-in-place call detected                          -> hook exit 2 (deny)
#   2 -- the check itself failed (bad stdin, bad module)      -> hook exit 2 (deny)
#   anything else (checker crashed/unrunnable)                -> hook exit 2 (deny)
#
# Fail-closed, same reasoning as the sibling secret-scan hook: an
# unverifiable comment write is a recoverable inconvenience (the agent's
# own self-heal/retry loop gets a clear signal and can retry); a comment
# silently edited in place because this hook no-op'd on its own failure
# reintroduces the exact incident this hook exists to prevent.
#
# The untrusted tool_input JSON travels to the checker via stdin only --
# never interpolated into a command string or passed as an argv element.

set -u

INPUT=$(cat)

# The checker is found relative to this script's own physical location
# (.claude/hooks/ -> ../../scripts/), never via $CLAUDE_PROJECT_DIR: a
# v1 `--phase research` spawn runs with CLAUDE_PROJECT_DIR=research-loop/
# and reaches this file through the research-loop/.claude -> ../.claude
# symlink, where $CLAUDE_PROJECT_DIR/scripts/ does not exist. `pwd -P`
# resolves that symlink. If any of this fails, CHECKER points nowhere and
# the "check failed" branch below denies.
HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P) || HOOK_DIR=""
CHECKER="${HOOK_DIR:-/nonexistent}/../../scripts/check-comment-edit-in-tool-input.ts"

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
    echo "BLOCKED: this call would edit an existing Jira/GitHub comment in place instead of creating a new one. Jira and GitHub both render comment threads in creation-time order, not edit order -- editing in place leaves the newest state pinned at its original position while newer replies land below it, making the threads look out of sync (this caused a real incident on TARS-1450). Always post a brand-new comment: omit commentId from addCommentToJiraIssue, and never PATCH an existing GitHub comment or use --edit-last. See SKILL.md's Setup: idempotent re-refinement / Ticket content protocol item 5." >&2
    exit 2
    ;;
  *)
    echo "BLOCKED: could not verify this call is free of edit-in-place behavior (the check itself failed to run) -- denying rather than risking a repeat of the TARS-1450 incident. Retry, or report this to a human if it keeps failing." >&2
    exit 2
    ;;
esac
