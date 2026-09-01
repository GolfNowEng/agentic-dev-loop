# Changelog

Notable fixes and behavior changes to the dev-loop pipeline itself
(`src/`, `.claude/skills/ticket-to-pr/`, `.claude/agents/qa-agent.md`).
Newest first. Not every commit needs an entry — only ones that change
what the loop is capable of or fix a failure mode a human had to
diagnose.

## 2026-09-01 — Redaction covered PII, not secrets, despite real credentials being reachable from every run

Ground/Red/Green/Verify run inside a per-run git worktree nested inside
the target repo's own directory tree — specifically so direnv picks up
the target repo's real local `.envrc`/`.env` (see `SKILL.md`'s "Target
repo" section). That's intentional and correct, but it also means real
secrets are reachable from inside a run. `src/redact.ts`'s `redactPII()`
only stripped email addresses and the literal `$HOME` path — it had no
concept of a secret value. Every line this process prints goes through
it via `log()`/`logError()` in `src/main.ts` (terminal output,
`--stream`'s live `tool_use`/`tool_result` echo, and the
`progress.jsonl` tail), so an `env`/`printenv` dump or a `cat .envrc`
from inside a Bash tool call would have passed through completely
unredacted.

**Fix**: added `redactSecrets()` and a `redactSensitive()` funnel
(`redactSecrets(redactPII(text))`) to `src/redact.ts` — a known-value
pass over `process.env` for secret-shaped variable names, plus a name/
value pattern pass for `NAME=value`/`export NAME=value` and JSON
`"name": "value"` shapes, plus AWS-key and JWT format backstops
regardless of variable name. `log()`/`logError()` in `src/main.ts` now
call `redactSensitive()` instead of `redactPII()`, and `verdict.detail`
(a skill's own self-report, which could in principle echo back
something it saw in Ground/Red/Green) is redacted before it flows into
the `runs.jsonl` log line. Also extended `SKILL.md`'s existing
no-absolute-paths rule to bar raw env var values, `.envrc`/`.env`
content, and credential/token/key/password values from the PR title or
body (presence/shape only), and added the same rule to
`qa-agent.md`'s "What NOT to do" section.

A companion fix for the identical gap (both repos share the same
composition-root pattern) landed in `research-loop` the same day.

### Follow-up the same day — the name/value patterns above corrupted JSON and silently skipped keys

Adversarial review of the fix above found two bugs in
`ENV_NAME_VALUE_PATTERN`/`JSON_NAME_VALUE_PATTERN`, confirmed by direct
execution rather than just theoretical: the optional trailing quote made
the value's end ambiguous. For a quoted value it stopped at the first
comma inside the value (`{"apiKey":"secret,value"}` became
`{"apiKey":REDACTED_SECRET,value"}` — invalid JSON). For an unquoted value
it could consume a following nested object's opening `{`, permanently
desyncing the regex's `lastIndex` and silently skipping every key after
it (a `clientSecret` nested one level deep was never redacted at all).

**Fix**: replaced each ambiguous pattern with an explicit quoted/unquoted
pair (`ENV_QUOTED_PATTERN`/`ENV_UNQUOTED_PATTERN`,
`JSON_QUOTED_PATTERN`/`JSON_UNQUOTED_PATTERN`) — quoted variants are
escape-aware (`(?:[^"\\]|\\.)*`) so an escaped `\"` doesn't terminate the
value early, unquoted variants exclude `{`, `[`, and `"` so they can never
wander into a following value's delimiter, and quoted patterns run first
so an already-redacted `"REDACTED_SECRET"` can't be re-matched by an
unquoted pattern. The env-style unquoted pattern deliberately does *not*
exclude comma (shell `NAME=value` has no comma-delimiter convention, so
excluding it truncated `TOKEN=abcdefgh,ijklmnop` and leaked the
remainder); the JSON unquoted pattern does exclude it, since comma is a
real JSON delimiter there. Also made the var-name match case-insensitive
(`.envrc`/shell scripts can use lowercase names like `github_token=`),
and added an unconditional backstop for credentials embedded in a
connection string/DSN (`postgres://user:pass@host` →
`postgres://REDACTED_SECRET@host`), independent of variable name.

**Known limitations, not fixed here**: PEM/SSH private-key blocks have no
`NAME=value` shape to match, and a bare secret value with no adjacent
key-name or URL context is out of reach of any name/value pattern
approach by construction. Flag for a future pass only if actually
observed leaking in a real run.

### Round 2, the same day — real enforcement on the PR-write channel, plus hardening

Adversarial review of the round-1 fix above (mirroring `research-loop`'s
own 3-agent review: logic/correctness, runtime-risk, security) found the
same architectural gap `research-loop` found on its Jira-comment channel:
the PR title/body channel had zero technical enforcement, just the prose
rule in `SKILL.md`. Round 2 broadens `SECRET_NAME_PATTERN` (adds
`SIGNING_KEY`/`ACCOUNT_KEY`/`ROLE_KEY`/`ENCRYPTION_KEY`/a standalone
`KEY`/`DSN`/`CONNECTION_STRING`/`DATABASE_URL`/`DB_URL`/`URI`/`COOKIE`/
`SESSION`, deliberately *not* a bare unanchored `KEY` substring match —
an earlier draft of this pattern would have matched `issueIdOrKey`,
present on nearly every Jira API response, and would have made the new
hook below deny legitimate calls), excludes `;` from
`ENV_UNQUOTED_PATTERN`'s value class (catches semicolon-delimited
connection-string segments like `AccountKey=`/`SharedAccessSignature=`
one segment at a time, no bespoke per-name pattern needed), adds three
bare-token format backstops (Stripe `sk_live_`/`rk_live_`/`pk_live_`,
GitHub `gh[oprsu]_`, Slack `xox[baprs]-`), and adds `containsSecret(text):
boolean` — a boolean check reusing `redactSecrets()`'s own patterns, one
source of truth.

**Caught by this round's own TDD process**: broadening
`SECRET_NAME_PATTERN` to include `DATABASE_URL`/`URI` initially broke the
existing connection-string-credential redaction — the generic name/value
pass started swallowing the *entire* URL value before
`CONNECTION_STRING_CREDENTIALS_PATTERN` (which redacts only the embedded
`user:pass@` segment and keeps host/port/path) got a chance to run. Fixed
by skipping URL-shaped values in the generic pass entirely, caught by two
pre-existing regression tests that would otherwise have silently broken.

**`src/main.ts`**: fixed a truncate-before-redact ordering bug in
`printStreamEvent()` — `--stream`'s live tool_use/tool_result echo
truncated output to 200 characters *before* calling `redactSensitive()`,
so a secret cut mid-value by truncation lost its closing quote and the
(now-unquoted) prefix printed in the clear. Fixed by redacting the full
value first, inside `truncate()` itself, then truncating the
already-redacted result. Verified by hand with a fake Stripe-shaped key
straddling the 200-char boundary (this file has no vitest coverage by
design).

**New: a code-level backstop on the PR title/body channel.** dev-loop has
no Jira-comment-writing tool at all — `ALLOWED_TOOLS` in `src/main.ts`
only grants read-only Atlassian MCP calls. The durable, human-facing
write this pipeline produces is the PR title/body, created via `gh pr
create`/`gh pr edit` — a `Bash` tool call, not a named MCP tool, which
made this a genuinely different matching problem than `research-loop`'s
fixed-tool-name matcher. Added a `PreToolUse` hook
(`.claude/hooks/block-secret-comments.sh` + `.claude/settings.json`)
matched on `Bash` itself: the hook script pre-filters cheaply (three
independent whole-word checks for `gh`, `pr`, and `create`/`edit` against
the command string) before ever invoking a new Node checker
(`scripts/check-secret-in-tool-input.ts`, reusing `containsSecret()`) —
chosen over scanning every single `Bash` call with Node, since `Bash` is
used constantly throughout every phase (git, tests, lint, build), unlike
`research-loop`'s much rarer Jira-write-only matcher. Denies (exit 2) any
`gh pr create`/`gh pr edit` command whose content matches a secret-shaped
pattern before it ever reaches the real `gh` CLI/GitHub API. Same
non-negotiable design points as `research-loop`'s hook, carried over
verbatim: the command string (which may contain PR body text straight
from ticket content) is read via stdin/`jq`/`JSON.parse` only, never
shell-interpolated or passed as a command-line argument; the hook fails
**closed** on any checker error (crash, bad stdin, missing file); and the
checker uses non-colliding exit codes (process exit 3 = secret found,
exit 2 = check failed) so a totally broken checker crashing before its
own error handling runs (Node's default crash exit code, 1) can't be
misread as "found a secret." Confirmed `$CLAUDE_PROJECT_DIR` is fixed to
this repo's own directory at hook-invocation time regardless of which
target-repo worktree a run later works in — `src/main.ts` spawns `claude
-p` with no `cwd` override, same as `research-loop`'s own verified
mechanism.

Also noted the new hook next to the existing PR-body secrets rule in
`SKILL.md` (~line 277).

**Residual gaps, round 2** (risk-reduction, not closed — same framing as
round 1): the hook is a name/format-anchored heuristic, not a semantic
secret detector. A bare secret value with no recognizable format (not one
of the three new bare-token shapes) and no adjacent key name still gets
through. PEM/SSH private-key blocks have no `NAME=value` or recognized
bare-token shape and remain unaddressed. A secret split across multiple
`gh pr edit` calls is scanned independently per call, not across the
run's history. A fully general high-entropy-string detector remains
explicitly out of scope (real false-positive cost, not a cheap addition
like the formats added this round).

## 2026-08-27 — Headless runs could stall forever on a Read permission prompt

`ALLOWED_TOOLS` in `src/main.ts` allowed `Bash` plus two Atlassian MCP
calls, but never `Read`, `Grep`, or `Glob`. `--permission-mode
acceptEdits` only auto-approves `Edit`/`Write`, not reads — and `Edit`
itself refuses to touch a file that hasn't been `Read` in-session first.
So the moment `ticket-to-pr` tried to edit a file it hadn't already
`cat`'d via `Bash`, it fell back to `Read`, hit an unanswerable
permission prompt (no human in a headless `-p` run), retried a few
times, and gave up without ever writing `verdict.json`.

Surfaced on `TARS-1341` (stuck retrying a `Read` on
`serverFetch.test.js` mid-Red-phase, three runs total once two
subsequent polls piled up and correctly bounced on the collision) but
had already caused the identical `agent_error` / "no run directory
appeared" signature on `TARS-1367` and four times in a row on
`TARS-1364` earlier — this was a recurring, intermittent failure, not a
one-off.

**Fix**: added `Read`, `Grep`, `Glob` to `ALLOWED_TOOLS` (`src/main.ts`).
