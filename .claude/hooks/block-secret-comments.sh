#!/bin/bash
# block-secret-comments.sh — PreToolUse hook for both roles' outward writes.
#
# One script, two input shapes (the merge of v1 dev-loop's and
# research-loop's hooks of the same name; settings.json wires it under both
# matchers):
#
#   - `Bash` (dev's write surface): the PR title/body and PR comments, via
#     `gh pr create`/`edit`/`comment`, `gh pr review --body`, or `gh api
#     ... -f body=`. This script pre-filters "could this be such a call"
#     itself before ever invoking Node, because the Bash matcher fires on
#     every Bash call in a run.
#   - `mcp__atlassian__*` writes (research's write surface): Jira comments/
#     edits/worklogs/issue links and Confluence page/comment writes. The
#     whole tool_input is scanned; the settings.json matcher decides which
#     tools reach this script.
#
# (Research's `gh issue create/edit/comment` writes are
# block-github-secret-writes.sh's job; the shared checker also scans them.)
#
# Requires `jq` on PATH. If `jq` is missing, the hook denies (exit 2) with
# a message naming `jq` specifically, distinct from its malformed-JSON
# message, so a missing binary is never mistaken for bad input.
#
# Pre-filter (Bash only): three independent whole-word checks (gh, pr,
# create-or-edit) rather than one regex with `.*`, which misses real
# invocations whose words land on different lines. Over-matching here (a
# command that merely mentions "gh pr create" in a string literal) is
# harmless -- one extra Node invocation, never a missed detection.
#
# Denies (exit 2) any matching write whose content contains a
# secret-shaped value (per src/core/redact.ts's containsSecret()) before it
# reaches GitHub/Jira/Confluence.
#
# Contract with the checker (scripts/check-secret-in-tool-input.ts), by its
# process exit code (NOT decideExitCode()'s internal 0|1|2 -- see that
# file's PROCESS_EXIT_CODE mapping for why "secret found" is 3, not 1):
#   0 -- clean / not a scanned write                       -> hook exit 0 (allow)
#   3 -- secret-shaped content found                       -> hook exit 2 (deny)
#   2 -- the check itself failed (bad stdin, bad module)   -> hook exit 2 (deny)
#   anything else (checker crashed before its own error    -> hook exit 2 (deny)
#     handling ran, e.g. Node's default exit 1, or the
#     checker isn't runnable / isn't there at all)
#
# The last two are the deliberate fail-CLOSED choice: an unverifiable write
# is a recoverable inconvenience (the agent gets a clear denial reason and
# can retry, or the run bounces with evidence); a secret that leaked into a
# real PR or Jira comment because this hook silently no-op'd is not
# recoverable. `exit 0` is reserved strictly for "the check ran and found
# nothing, or this wasn't a guarded write" -- never for "couldn't tell."
#
# The untrusted tool input travels to the checker via stdin only -- never
# interpolated into a second shell invocation or passed as an argv element
# (which would also leak it into ps/proc listings on a shared host).

set -u

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: jq not found on PATH (required by the secret-scan hook) -- install jq. Denying to stay fail-closed." >&2
  exit 2
fi

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
JQ_EXIT=$?
if [ "$JQ_EXIT" -eq 0 ]; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
  JQ_EXIT=$?
fi

if [ "$JQ_EXIT" -ne 0 ]; then
  echo "BLOCKED: could not parse this tool call's input (malformed JSON) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
  exit 2
fi

if [ "$TOOL_NAME" = "Bash" ]; then
  # Cheap pre-filter: only a command that mentions gh AND either pr plus
  # (create, edit, comment or review) or api plus body= as whole words is
  # worth scanning. Every other Bash call (git, npm test, lint, build -- the
  # vast majority) short-circuits here. The checker narrows it further
  # (gh pr review only with --body/-b, gh api only with -f/-F body=).
  if ! printf '%s' "$COMMAND" | grep -qw "gh"; then
    exit 0
  fi
  if printf '%s' "$COMMAND" | grep -qw "pr" && printf '%s' "$COMMAND" | grep -Eqw "create|edit|comment|review"; then
    :
  elif printf '%s' "$COMMAND" | grep -qw "api" && printf '%s' "$COMMAND" | grep -q "body="; then
    :
  else
    exit 0
  fi
  WHAT="gh pr/api write command"
  ADVICE="Never write a raw env var value, .envrc/.env content, API key, token, or password into a PR title or body -- report presence/shape only (e.g. \"reads API_KEY from env\"), the same rule ticket-to-pr's PR body section already requires."
else
  WHAT="write"
  ADVICE="Never paste a raw env var value, .envrc/.env content, API key, token, or password into a Jira/Confluence write -- report presence/shape only (e.g. hasClientSecret: true), the same pattern ticket-refine's Ticket content protocol already requires."
fi

# The checker is found relative to this script's own physical location
# (.claude/hooks/ -> ../../scripts/), never via $CLAUDE_PROJECT_DIR, so it
# resolves even when the project dir is unset or wrong; `pwd -P` also
# resolves any symlinked path to this file. If any of this fails, CHECKER
# points nowhere and the "check failed" branch below denies.
HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P) || HOOK_DIR=""
CHECKER="${HOOK_DIR:-/nonexistent}/../../scripts/check-secret-in-tool-input.ts"

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
    echo "BLOCKED: this $WHAT contains a secret-shaped value (matched a known secret name/format pattern in src/core/redact.ts). $ADVICE" >&2
    exit 2
    ;;
  *)
    echo "BLOCKED: could not verify this $WHAT is free of secret-shaped content (the secret-scan check itself failed to run) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
    exit 2
    ;;
esac
