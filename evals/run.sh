#!/usr/bin/env bash
# Run ONE eval scenario against the sandbox (Task 16, spec §9.2):
#   npm run eval -- clean              DRY (the default): prints every outward command as DRY: ..., runs none
#   DRY_RUN=0 npm run eval -- clean    LIVE: real Jira tickets, sandbox PRs, paid claude runs
#   DRY_RUN=0 npm run eval -- --all    LIVE, all five in order; stops at the first failure
# DRY_RUN unset/empty/1 is dry; exactly 0 is live; anything else is refused.
#
# A real run costs money (one research + one dev phase run per ticket) and
# writes real Jira tickets and sandbox PRs: see evals/README.md first. A
# failed scenario is never auto-retried.
#
# Per scenario: preflight -> scenario setup (creates the eval tickets,
# records their keys in $STATE_DIR/keys) -> export DEVLOOP_EVAL_KEYS and
# GH_REPO -> the loop with --once under a wall-clock limit (once per ticket
# the scenario works) -> the grader.
set -u
. "$(dirname "$0")/lib.sh"

# A live run is paid and writes real Jira tickets and sandbox PRs: never from
# inside a Claude Code session (CLAUDECODE is set there, including for a
# `claude -p` agent whose cwd is this repo). Dry mode still runs (M5).
if [ "$EVAL_MODE" = live ] && [ -n "${CLAUDECODE+set}" ]; then
  die "DRY_RUN=0 (live) refused: CLAUDECODE is set, so this is running inside a Claude Code session; a human must run live evals from their own shell"
fi

SCENARIOS="clean ambiguous dev-bounce blocked queue"
# research 120 + dev 75 min runTimeoutMin, plus slack.
RUN_TIMEOUT_S="${EVAL_RUN_TIMEOUT_S:-12600}"

usage() {
  log "usage: [DRY_RUN=0] npm run eval -- <$(echo "$SCENARIOS" | tr ' ' '|')> | --all"
  log "  dry by default (DRY_RUN unset/empty/1); DRY_RUN=0 is a LIVE, paid run; any other DRY_RUN value is refused"
  exit 2
}

[ "$#" -eq 1 ] || usage
case "$1" in
  --all) LIST="$SCENARIOS" ;;
  *)
    LIST=""
    for s in $SCENARIOS; do [ "$1" = "$s" ] && LIST="$s"; done
    [ -n "$LIST" ] || { log "unknown scenario: $1"; usage; }
    ;;
esac

mkdir -p "$STATE_DIR/tmp" || die "cannot create $STATE_DIR"
log "mode: $EVAL_MODE"
if is_dry; then
  KEYS_FILE="$STATE_DIR/keys.dry"
  : > "$KEYS_FILE"
  log "dry run (set DRY_RUN=0 for a live run): no outward command runs; placeholder keys go to keys.dry"
else
  KEYS_FILE="$STATE_DIR/keys"
fi
DRY_N=0

# new_ticket <summary> <description-file> [--trigger] -> sets NEW_KEY, records it.
new_ticket() {
  local out
  out=$(jira create --summary="$1" --description-file="$2" ${3:+"$3"}) || die "ticket create failed"
  if is_dry; then DRY_N=$((DRY_N + 1)); out="DRY-$DRY_N"; fi
  valid_key "$out" || die "ticket create returned no key"
  printf '%s\n' "$out" >> "$KEYS_FILE"
  NEW_KEY=$out
}

# describe <name> : writes the scenario's ticket text (stdin) to a temp file, prints its path.
describe() { local f="$STATE_DIR/tmp/$1.txt"; cat > "$f"; printf '%s' "$f"; }

run_scenario() {
  local name=$1 i keys_csv
  log "scenario $name"
  bash "$EVALS/preflight.sh" || die "preflight failed; nothing was created"

  KEYS=""; GRADE_ARGS=""; LOOPS=1
  # shellcheck source=/dev/null
  . "$EVALS/scenarios/$name.sh"
  setup || die "scenario $name: setup failed"

  # The loop finds work only through Jira search, which lags a new ticket by ~30s.
  # shellcheck disable=SC2086
  [ -z "$KEYS" ] || jira wait-searchable $KEYS || die "scenario $name: Jira search never found the new tickets"

  keys_csv=$(echo $KEYS | tr ' ' ',')
  export DEVLOOP_EVAL_KEYS="$keys_csv"
  export GH_REPO="$SANDBOX"
  log "DEVLOOP_EVAL_KEYS=$DEVLOOP_EVAL_KEYS"
  log "GH_REPO=$GH_REPO"
  printf '%s %s\n' "$name" "$keys_csv" >> "$STATE_DIR/scenarios$(is_dry && echo .dry)"

  i=0
  while [ "$i" -lt "$LOOPS" ]; do
    i=$((i + 1))
    log "scenario $name: iteration $i/$LOOPS (limit ${RUN_TIMEOUT_S}s)"
    outward run_to "$RUN_TIMEOUT_S" npm run loop -- --config="$EVAL_CONFIG" --once || log "scenario $name: the loop exited non-zero (graded anyway)"
  done

  # shellcheck disable=SC2086
  if outward node --env-file="${DEVLOOP_ENV_FILE:-.env}" "$EVALS/check-$name.mjs" --config="$EVAL_CONFIG" $GRADE_ARGS; then
    log "scenario $name: graded (see the JSON line above)"
    return 0
  fi
  log "scenario $name: FAILED (not retried)"
  return 1
}

cd "$ROOT" || die "cannot cd to the repo root"
for s in $LIST; do
  run_scenario "$s" || exit 1
done
log "done: $LIST"
