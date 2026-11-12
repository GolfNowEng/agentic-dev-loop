#!/usr/bin/env bash
# Clean up after evals (Task 16, spec §9.2). Prints what it would close and
# closes nothing unless --write is passed:
#   bash evals/reset.sh            list only
#   bash evals/reset.sh --write    close them
#
# A Jira ticket is eligible only if ALL hold: its key is in
# $STATE_DIR/keys (written by run.sh), it carries the dev-loop-eval label,
# and its summary starts with [dev-loop-eval] (checked live by
# `jira.mjs eligible`; `jira.mjs close` re-checks before writing). Open
# sandbox PRs whose head branch starts with an eligible key are closed
# only on the sandbox repo, behind assert_repo. Nothing else is touched;
# the keys file is kept (append-only history).
set -u
. "$(dirname "$0")/lib.sh"
cd "$ROOT" || die "cannot cd to the repo root"

WRITE=0
case "${1:-}" in
  "") ;;
  --write) WRITE=1 ;;
  *) die "usage: bash evals/reset.sh [--write]" ;;
esac

KEYS_FILE="$STATE_DIR/keys"
[ -f "$KEYS_FILE" ] || { log "no $KEYS_FILE: nothing to reset"; exit 0; }

ELIGIBLE=""
for key in $(sort -u "$KEYS_FILE"); do
  if ! valid_key "$key"; then
    log "skipping a malformed line in the keys file"
    continue
  fi
  if jira eligible "$key"; then
    ELIGIBLE="$ELIGIBLE $key"
  else
    log "$key: not an eval ticket (label/prefix missing): skipped"
  fi
done
log "eligible:${ELIGIBLE:- none}$(is_dry && echo ' (DRY_RUN: eligibility not checked)')"

assert_repo "$EVAL_REPO"
PRS=$(api GET "pulls?state=open&per_page=100" --jq '.[] | "\(.number) \(.head.ref)"') || die "listing sandbox PRs failed"
CLOSE_PRS=""
for key in $ELIGIBLE; do
  while read -r n ref; do
    [ -n "${n:-}" ] || continue
    case "$ref" in "$key"|"$key"-*) CLOSE_PRS="$CLOSE_PRS $n" ;; esac
  done <<EOF
$PRS
EOF
done
log "sandbox PRs:${CLOSE_PRS:- none}"

if [ "$WRITE" -ne 1 ]; then
  log "list only; pass --write to close the tickets and PRs above"
  exit 0
fi

for key in $ELIGIBLE; do jira close "$key" || log "$key: close failed"; done
for n in $CLOSE_PRS; do
  assert_repo "$EVAL_REPO"
  api PATCH "pulls/$n" -f state=closed >/dev/null || log "PR #$n: close failed"
done
log "reset done"
