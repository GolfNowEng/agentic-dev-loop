#!/bin/bash
# block-secret-comments.sh — PreToolUse hook for Bash calls.
#
# dev-loop's outward write surface for a landed ticket is the PR title/
# body, created via `gh pr create`/`gh pr edit` (a Bash tool call, not a
# named MCP tool the way research-loop's Jira-comment writes are) -- so
# this hook's matcher is Bash itself, and this script does its own
# recognition of "is this actually a gh pr create/edit call" before ever
# invoking the Node checker.
#
# Pre-filters cheaply via three independent whole-word checks (gh, pr,
# create-or-edit) against the extracted command string before invoking
# Node at all -- chosen over a single combined regex because Bash fires
# on every single Bash tool call in a run (far more frequent than
# research-loop's Jira-write-only matcher), and a single regex with `.*`
# between the words was empirically found to miss real invocations whose
# words land on different lines (`.` doesn't match newlines by default).
# Independent word-presence checks have no such gap and still correctly
# reject gh pr view / gh issue create / unrelated commands. Over-matching
# here (e.g. a command that merely mentions "gh pr create" in a string
# literal) is harmless -- it just costs one extra Node invocation, never a
# missed detection, since the real secret scan still runs on the full
# command string when the pre-filter passes.
#
# Denies (exit 2) any gh pr create/edit call whose command string contains
# a secret-shaped value (per src/redact.ts's containsSecret()) before it
# ever reaches the real `gh` CLI / GitHub API.
#
# Contract with the checker (scripts/check-secret-in-tool-input.ts), by its
# process exit code (NOT the same as decideExitCode()'s internal 0|1|2 --
# see that file's PROCESS_EXIT_CODE mapping for why "secret found" is
# process exit code 3, not 1):
#   0 -- clean, not a gh pr create/edit call, or no secret-shaped content
#        found                                            -> hook exit 0 (allow)
#   3 -- secret-shaped content found                       -> hook exit 2 (deny)
#   2 -- the check itself failed (bad stdin, bad module)    -> hook exit 2 (deny)
#   anything else (checker crashed before its own error      -> hook exit 2 (deny)
#     handling could run, producing Node's own default
#     exit code 1, or the checker isn't runnable at all)
#
# The last two are the deliberate fail-CLOSED choice: an unverifiable PR
# write is a recoverable inconvenience (the loop runner's own retry
# machinery gets a clear denial reason and can retry the Bash call, or
# the run bounces with concrete evidence -- see SKILL.md's Bouncing
# section); a secret that leaked into a real, public PR because this hook
# silently no-op'd on its own failure is not recoverable. `exit 0` is
# reserved strictly for "the check ran and found nothing, or this wasn't
# even a gh pr create/edit call" -- never a fallback for "couldn't tell."
#
# The untrusted command string (which may contain PR title/body text
# straight from ticket content) travels to the checker via stdin only --
# never interpolated into a second shell invocation or passed as a
# command-line argument (which would leak it into ps/proc process listings
# on a shared host). Node's JSON.parse reads it purely as data.

set -u

INPUT=$(cat)

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
JQ_EXIT=$?

if [ "$JQ_EXIT" -ne 0 ]; then
  echo "BLOCKED: could not parse this tool call's input (malformed JSON) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
  exit 2
fi

# Cheap pre-filter: only a command that mentions gh, pr, AND (create or
# edit) as whole words is worth scanning at all. Every other Bash call
# (git, npm test, lint, build, etc. -- the vast majority of calls in a
# run) short-circuits here without ever invoking Node.
if ! printf '%s' "$COMMAND" | grep -qw "gh"; then
  exit 0
fi
if ! printf '%s' "$COMMAND" | grep -qw "pr"; then
  exit 0
fi
if ! printf '%s' "$COMMAND" | grep -Eqw "create|edit"; then
  exit 0
fi

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
    echo "BLOCKED: this gh pr create/edit command contains a secret-shaped value (matched a known secret name/format pattern in src/redact.ts). Never write a raw env var value, .envrc/.env content, API key, token, or password into a PR title or body -- report presence/shape only (e.g. \"reads API_KEY from env\"), the same rule SKILL.md's PR body section already requires." >&2
    exit 2
    ;;
  *)
    echo "BLOCKED: could not verify this gh pr create/edit command is free of secret-shaped content (the secret-scan check itself failed to run) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
    exit 2
    ;;
esac
