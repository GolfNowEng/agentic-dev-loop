#!/usr/bin/env bash
# Shared helpers for the eval harness (Task 16, spec §9.2). Source this
# file; do not execute it. Ported from poc-stacked-prs/harness/lib.sh.
# Bash 3.2 compatible (macOS default): no associative arrays, no mapfile.
#
# Every outward command (GitHub, Jira, the paid loop) goes through ONE
# function, `outward`. With DRY_RUN=1 it prints `DRY: <cmd>` on stderr and
# runs nothing, so dry-run coverage is structural: a test greps evals/*.sh
# for any gh/curl/npm/claude call that does not start with `outward`.

SANDBOX="JustinChan-fd/dev-loop-eval-sandbox"
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

is_dry() { [ "${DRY_RUN:-0}" = 1 ]; }

# The one gate for every outward command.
outward() {
  if is_dry; then
    printf 'DRY: %s\n' "$*" >&2
    return 0
  fi
  "$@"
}

# macOS has no timeout(1). Run a command with a wall-clock limit (seconds).
run_to() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec failed: $!"' "$s" "$@"; }

# Every GitHub REST call is pinned to the sandbox repo.
api() { local m=$1 p=$2; shift 2; outward gh api -X "$m" "repos/$SANDBOX/$p" "$@"; }

# The Jira helper, with the env file the loop uses (never read here).
jira() { outward node --env-file="${DEVLOOP_ENV_FILE:-.env}" "$EVALS/jira.mjs" "$@"; }

# Refuse anything but the sandbox repo slug.
assert_repo() {
  [ "${1:-}" = "$SANDBOX" ] || die "repo is not the sandbox ($SANDBOX): ${1:-<empty>}"
}

# Refuse git work anywhere except a clone whose origin is the sandbox.
assert_clone() {
  local d=$1 top url u
  top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || die "not a git repo: $d"
  [ "$top" = "$(cd "$d" && pwd -P)" ] || die "git root mismatch for $d (got $top)"
  url=$(git -C "$d" remote get-url origin 2>/dev/null) || die "no origin in $d"
  for u in $SANDBOX_URLS; do [ "$url" = "$u" ] && return 0; done
  die "origin of $d is not the sandbox repo: $url"
}

valid_key() { printf '%s' "$1" | grep -Eq "$KEY_RE"; }
