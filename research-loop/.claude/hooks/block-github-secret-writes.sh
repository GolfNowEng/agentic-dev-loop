#!/bin/bash
# block-github-secret-writes.sh — PreToolUse hook for Bash calls that
# write to a GitHub Issue.
#
# Requires `jq` on PATH (confirmed present: jq-1.7.1). Denies (exit 2) any
# gh issue create/edit/comment call whose command string contains a
# secret-shaped value (per src/redact.ts's containsSecret(), via the
# shared scripts/check-secret-in-tool-input.ts checker -- the same checker
# research-loop's existing Atlassian-MCP hook uses, extended in this
# change to also recognize gh issue create/edit/comment Bash calls).
#
# Mandatory Phase 1 launch blocker per docs/future-enhancements.md's Jira
# label-trigger design -- this hook must exist before ticket-refine writes
# any real recon/attack/verify content to a GitHub Issue (see SKILL.md's
# Ticket content protocol / routing rule).
#
# Adapted from dev-loop's own .claude/hooks/block-secret-comments.sh (its
# gh-Bash-matcher variant, for gh pr create/edit) -- same fail-closed exit-
# code contract:
#   0 -- clean, not a gh issue write, or no secret-shaped content found -> hook exit 0 (allow)
#   3 -- secret-shaped content found                                    -> hook exit 2 (deny)
#   2 -- the check itself failed (bad stdin, bad module)                 -> hook exit 2 (deny)
#   anything else (checker crashed/unrunnable)                          -> hook exit 2 (deny)
#
# The untrusted command string travels to the checker via stdin only --
# never interpolated into a shell command or passed as an argv element
# (which would leak it into ps/proc process listings on a shared host).

set -u

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: jq not found on PATH (required by the GitHub secret-scan hook) -- install jq. Denying to stay fail-closed." >&2
  exit 2
fi

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
JQ_EXIT=$?

if [ "$JQ_EXIT" -ne 0 ]; then
  echo "BLOCKED: could not parse this tool call's input (malformed JSON) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
  exit 2
fi

# Cheap pre-filter: only a command mentioning gh, issue, AND (create,
# edit, or comment) as whole words is worth scanning at all. Every other
# Bash call (git, npm test, gh pr create, gh issue view, etc.) short-
# circuits here without ever invoking Node.
if ! printf '%s' "$COMMAND" | grep -qw "gh"; then
  exit 0
fi
if ! printf '%s' "$COMMAND" | grep -qw "issue"; then
  exit 0
fi
if ! printf '%s' "$COMMAND" | grep -Eqw "create|edit|comment"; then
  exit 0
fi

CHECKER="${CLAUDE_PROJECT_DIR:-}/scripts/check-secret-in-tool-input.ts"

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
    echo "BLOCKED: this gh issue create/edit/comment command contains a secret-shaped value (matched a known secret name/format pattern in src/redact.ts). Never write a raw env var value, .envrc/.env content, API key, token, or password into a GitHub Issue -- report presence/shape only (e.g. \"reads API_KEY from env\"), the same rule SKILL.md's Ticket content protocol already requires for Jira." >&2
    exit 2
    ;;
  *)
    echo "BLOCKED: could not verify this gh issue command is free of secret-shaped content (the secret-scan check itself failed to run) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
    exit 2
    ;;
esac
