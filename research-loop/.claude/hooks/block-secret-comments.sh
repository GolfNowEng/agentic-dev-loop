#!/bin/bash
# block-secret-comments.sh — PreToolUse hook for Atlassian write calls.
#
# Denies (exit 2) any Jira/Confluence write whose tool_input contains a
# secret-shaped value (per src/redact.ts's containsSecret()) before it
# ever reaches the real API. This is the real code-level backstop behind
# the prose-only "never paste a raw secret into a Jira comment" instruction
# in SKILL.md/the agent .md files -- see CHANGELOG.md for the full context.
#
# Contract with the checker (scripts/check-secret-in-tool-input.ts), by its
# process exit code (note: NOT the same as decideExitCode()'s internal
# 0|1|2 -- see that file's PROCESS_EXIT_CODE mapping and comment for why
# "secret found" is process exit code 3, not 1):
#   0 -- clean, no secret-shaped content found              -> hook exit 0 (allow)
#   3 -- secret-shaped content found                         -> hook exit 2 (deny)
#   2 -- the check itself failed (bad stdin, bad module)      -> hook exit 2 (deny)
#   anything else (e.g. `node`/the script not runnable at     -> hook exit 2 (deny)
#     all, or an uncaught crash producing Node's own default
#     exit code 1) -- treated the same as "check failed"
#
# The last two are the deliberate fail-CLOSED choice: an unverifiable Jira
# write is a recoverable inconvenience (the agent's own self-heal/retry
# loop -- capped at 4 cycles per run, see SKILL.md Step 7 -- gets a clear
# signal and can retry); a secret that leaked into Jira because this hook
# silently no-op'd on its own failure is not recoverable. `exit 0` is
# reserved strictly for "the check ran and found nothing" -- never used as
# a fallback for "couldn't tell."
#
# The untrusted tool_input JSON travels to the checker via stdin only --
# never interpolated into a command string or passed as an argv element
# (which would also leak it into `ps`/`/proc` process listings on a shared
# host). See check-secret-in-tool-input.ts's own header comment.

set -u

INPUT=$(cat)

CHECKER="$CLAUDE_PROJECT_DIR/scripts/check-secret-in-tool-input.ts"

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
    echo "BLOCKED: this write contains a secret-shaped value (matched a known secret name/format pattern in src/redact.ts). Never paste a raw env var value, .envrc/.env content, API key, token, or password into a Jira/Confluence write -- report presence/shape only (e.g. hasClientSecret: true), the same pattern SKILL.md's Ticket content protocol already requires." >&2
    exit 2
    ;;
  *)
    echo "BLOCKED: could not verify this write is free of secret-shaped content (the secret-scan check itself failed to run) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
    exit 2
    ;;
esac
