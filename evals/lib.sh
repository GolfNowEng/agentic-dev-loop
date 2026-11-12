#!/usr/bin/env bash
# Shared helpers for the eval harness (Task 16, spec §9.2). Source this
# file; do not execute it. Ported from poc-stacked-prs/harness/lib.sh.
# Bash 3.2 compatible (macOS default): no associative arrays, no mapfile.
#
# Every outward command (GitHub, Jira, the paid loop) goes through ONE
# function, `outward`. In dry mode it prints `DRY: <cmd>` on stderr and
# runs nothing, so dry-run coverage is structural: a test greps evals/*.sh
# for any gh/curl/npm/claude call that does not start with `outward`.
#
# Dry is the DEFAULT. The mode comes from DRY_RUN:
#   unset, empty or 1  -> dry  (prints, runs nothing)
#   exactly 0          -> live (real Jira writes, real sandbox PRs, paid runs)
#   anything else      -> refused (exit 1): DRY_RUN=true is NOT live.
# It is checked when this file is sourced and again on every `outward`
# call, so a value changed after sourcing cannot turn a call live.

SANDBOX="JustinChan-fd/dev-loop-eval-sandbox"
# The repo `api` calls. Overridable only so a test can prove assert_repo
# guards it; any value but $SANDBOX is refused before a call.
EVAL_REPO="${EVAL_REPO:-$SANDBOX}"
SANDBOX_URLS="git@github.com:${SANDBOX}.git https://github.com/${SANDBOX}.git https://github.com/${SANDBOX}"
EVALS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$EVALS/.." && pwd -P)"
STATE_DIR="${EVAL_STATE_DIR:-$EVALS/.state}"
EVAL_CONFIG="${EVAL_CONFIG:-pipeline.eval.config.json}"
EVAL_LABEL="dev-loop-eval"
EVAL_PREFIX="[dev-loop-eval]"
KEY_RE='^[A-Z][A-Z0-9_]+-[0-9]+$'

log() { printf '[eval] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# Prints dry|live, or fails (non-zero, nothing printed on stdout) on a bad value.
eval_mode() {
  case "${DRY_RUN-}" in
    ""|1) echo dry ;;
    0) echo live ;;
    *)
      printf '[eval] FATAL: DRY_RUN must be unset/empty/1 (dry) or exactly 0 (live); got %s. Refusing.\n' "\"${DRY_RUN}\"" >&2
      return 1
      ;;
  esac
}

EVAL_MODE=$(eval_mode) || exit 1

is_dry() { [ "$(eval_mode)" = dry ]; }

# The one gate for every outward command. Re-parses DRY_RUN each call:
# a bad value refuses, and only exactly 0 runs the command.
outward() {
  local mode
  mode=$(eval_mode) || exit 1
  if [ "$mode" = dry ]; then
    printf 'DRY: %s\n' "$*" >&2
    return 0
  fi
  "$@"
}

# macOS has no timeout(1). Run a command with a wall-clock limit (seconds).
run_to() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec failed: $!"' "$s" "$@"; }

# Every GitHub REST call is pinned to the sandbox repo: the repo it uses
# ($EVAL_REPO) is asserted before each call.
api() { local m=$1 p=$2; shift 2; assert_repo "$EVAL_REPO"; outward gh api -X "$m" "repos/$EVAL_REPO/$p" "$@"; }

# The Jira helper, with the env file the loop uses (never read here).
jira() { outward node --env-file="${DEVLOOP_ENV_FILE:-.env}" "$EVALS/jira.mjs" "$@"; }

# Refuse anything but the sandbox repo slug.
assert_repo() {
  [ "${1:-}" = "$SANDBOX" ] || die "repo is not the sandbox ($SANDBOX): ${1:-<empty>}"
}

is_sandbox_url() { local u; for u in $SANDBOX_URLS; do [ "$1" = "$u" ] && return 0; done; return 1; }

# Refuse git work anywhere except a clone whose origin (fetch AND push URL)
# is the sandbox.
assert_clone() {
  local d=$1 top url push
  top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || die "not a git repo: $d"
  [ "$top" = "$(cd "$d" && pwd -P)" ] || die "git root mismatch for $d (got $top)"
  url=$(git -C "$d" remote get-url origin 2>/dev/null) || die "no origin in $d"
  is_sandbox_url "$url" || die "origin of $d is not the sandbox repo: $url"
  push=$(git -C "$d" remote get-url --push origin 2>/dev/null) || die "no origin push URL in $d"
  is_sandbox_url "$push" || die "origin push URL of $d is not the sandbox repo: $push"
}

valid_key() { printf '%s' "$1" | grep -Eq "$KEY_RE"; }
