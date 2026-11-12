#!/bin/bash
# block-unsafe-git.sh — PreToolUse hook for every Bash call.
#
# Design constraint A4 as a runtime guard, not just prompt text. Banned,
# denied with exit 2:
#   - banned force pushes: `--force`, `-f`, `--force-with-lease`,
#     `--force-if-includes` (banned), `+refspec`, `--mirror`;
#   - banned hook bypasses: `--no-verify`, `git commit -n`, `git push -n`,
#     `core.hooksPath` overrides, `HUSKY=0`;
#   - banned: `gh stack push|sync|submit`;
# including inside `&&`/`||`/`;`/`|` chains, subshells, `$( )`, `bash -c "..."`, `eval`, and
# behind env assignments or wrappers like `env`/`nohup`/`timeout`. `-n` is
# denied only as a flag of `git commit`/`git push`, so `git grep -n` and
# `git log -n 5` are allowed. All parsing lives in the checker,
# scripts/check-unsafe-git-in-tool-input.ts (see its header for the
# approach).
#
# Exit-code contract with the checker (same as the sibling hooks):
#   0 -- nothing unsafe                                       -> hook exit 0 (allow)
#   3 -- unsafe invocation found (stdout: the rule name)       -> hook exit 2 (deny)
#   2 -- could not verify (unparseable command, a flag only    -> hook exit 2 (deny)
#        known at run time, bad stdin; stdout: the reason)
#   anything else (checker crashed / missing / not runnable)   -> hook exit 2 (deny)
#
# Fail-closed: a hook that cannot tell is a hook that denies. A blocked safe
# command costs one retry with a plainer spelling; a force push or skipped
# pre-push hook that slipped through is not recoverable.
#
# Requires `jq` on PATH (same as the sibling Bash hooks). The untrusted
# command travels to the checker via stdin only; the checker's stdout is a
# fixed string from the checker, never part of the command.

set -u

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: jq not found on PATH (required by the unsafe-git hook) -- install jq. Denying to stay fail-closed." >&2
  exit 2
fi

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "BLOCKED: could not parse this tool call's input (malformed JSON) -- could not verify it is free of force pushes or hook bypasses. Retry, or report this to a human if it keeps failing." >&2
  exit 2
fi

if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# The checker is found relative to this script's own physical location
# (.claude/hooks/ -> ../../scripts/), never via $CLAUDE_PROJECT_DIR, so it
# resolves even when the project dir is unset or wrong; `pwd -P` also
# resolves any symlinked path to this file. If any of this fails, CHECKER
# points nowhere and the "check failed" branch below denies.
HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P) || HOOK_DIR=""
CHECKER="${HOOK_DIR:-/nonexistent}/../../scripts/check-unsafe-git-in-tool-input.ts"

EXIT_CODE=2
DETAIL=""
if [ -f "$CHECKER" ]; then
  DETAIL=$(printf '%s' "$INPUT" | node "$CHECKER" 2>/dev/null)
  EXIT_CODE=$?
fi

case "$EXIT_CODE" in
  0)
    exit 0
    ;;
  3)
    echo "BLOCKED: ${DETAIL:-unsafe git/gh invocation}. Force pushes (--force, -f, --force-with-lease, --force-if-includes, +refspec), hook bypasses (--no-verify, git commit/push -n, core.hooksPath, HUSKY=0) and gh stack push/sync/submit are never allowed in this pipeline (design constraint A4). A rejected push or a failing hook is a blocker to report -- bounce with the evidence, do not work around it." >&2
    exit 2
    ;;
  2)
    case "$DETAIL" in
      *"git push argument only known at run time"*)
        HOW="For the push target, spell the branch name literally, or use HEAD (e.g. git push -u origin HEAD) -- never a variable or \$(...)."
        ;;
      *)
        HOW="Rewrite it with every git/gh flag spelled out literally (no variables for flags or refspecs)."
        ;;
    esac
    echo "BLOCKED: could not verify this command is free of force pushes and hook bypasses (${DETAIL:-the check failed}) -- denying to stay fail-closed. $HOW Report this to a human if it keeps failing." >&2
    exit 2
    ;;
  *)
    echo "BLOCKED: could not verify this command is free of force pushes and hook bypasses (the unsafe-git check itself failed to run) -- denying to stay fail-closed. Retry, or report this to a human if it keeps failing." >&2
    exit 2
    ;;
esac
