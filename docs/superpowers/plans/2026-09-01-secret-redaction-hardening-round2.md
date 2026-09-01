# Secret Redaction Hardening (Round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port research-loop's round-2 secret-redaction hardening (`src/redact.ts` pattern broadening, the truncate-before-redact ordering fix, `engines.node` pin) into dev-loop verbatim where it's not repo-specific, and design + implement a *new* `PreToolUse` hook that denies any `gh pr create`/`gh pr edit` Bash call whose PR title/body contains a secret-shaped value — dev-loop's equivalent of research-loop's Jira/Confluence-write hook, adapted because dev-loop's write surface is a `Bash` call, not a named MCP tool.

**Architecture:** `src/redact.ts` gets the same broadened `SECRET_NAME_PATTERN`, three bare-token backstops, and `containsSecret()` that research-loop already shipped and tested in commit `334ced5` — copied as tested code, not re-derived. `src/main.ts` gets the truncate-order fix. A new `scripts/check-secret-in-tool-input.ts` reuses `containsSecret()` to scan `tool_input.command` (extracted via `jq` on stdin, never shell-interpolated) for a `gh pr create`/`gh pr edit` shape before scanning it; a new `.claude/hooks/block-secret-comments.sh` wires it to a `Bash`-matched `PreToolUse` hook in `.claude/settings.json`, with the same fail-closed exit-code contract (3 = secret found, 2 = checker broken, other = crash) research-loop uses. Every step is TDD: failing test first, confirm red, implement, confirm green.

**Tech Stack:** TypeScript (Node's built-in type-stripping, no build step for `src/*.ts` at runtime), vitest, bash, jq, `gh` CLI.

**Spec:** This plan implements the task prompt given directly in-conversation (no separate spec doc) — its full text is reproduced in context above. The verified reference implementation it ports from is `research-loop` commit `334ced5` (`src/redact.ts`, `test/redact.test.ts`, `.claude/hooks/block-secret-comments.sh`, `scripts/check-secret-in-tool-input.ts`, `test/hooks/block-secret-comments.test.mjs`, `.claude/settings.json`), read directly from `/Users/206618626@bwt3.com/Desktop/Repos/research-loop` during planning.

## Global Constraints

- `npm test` must be green before and after every change to `src/` (122 baseline tests today).
- `npm run build` (`tsc --noEmit`) must be clean after every change.
- TDD strictly: every new behavior gets a failing test, confirmed red, before implementation.
- Never shell-interpolate untrusted content (PR command strings) — read via stdin/`jq -r` only, never as a `node -e` source string or a command-line argument.
- Fail closed: any hook-checker error (crash, bad stdin, missing file) denies (exit 2), never silently allows.
- Reuse `containsSecret()` from `src/redact.ts` as the hook's single source of truth — no second detection implementation.
- **A hook denial or checker failure must never permanently block a real ticket** — the loop runner's own retry/self-heal machinery (Bash tool-call retry inside the `claude -p` run) must remain the recovery path; this hardening only needs to make a real leak attempt visibly fail, not introduce a new bounce category. See Task 6's note.
- `package.json` gets `"engines": { "node": ">=22.18.0" }`.

---

## Context recap: what's already true today (verified by reading the code, not assumed)

- `src/redact.ts`'s round-1 `SECRET_NAME_PATTERN`, `ENV_QUOTED_PATTERN`/`ENV_UNQUOTED_PATTERN`, `JSON_QUOTED_PATTERN`/`JSON_UNQUOTED_PATTERN`, `AWS_KEY_PATTERN`, `JWT_PATTERN`, `CONNECTION_STRING_CREDENTIALS_PATTERN`, `redactSecrets()`, `redactPII()`, `redactSensitive()` all already exist and are already tested (122 passing tests today). This plan **extends** them; it does not re-create round 1.
- `src/main.ts` already calls `redactSensitive()` in `log()`/`logError()` and already redacts `verdict.detail` before it hits `runs.jsonl` — round 1's main.ts work is already done. The **only** remaining main.ts gap is the truncate-before-redact ordering bug in `printStreamEvent()`'s `truncate()` helper (`src/main.ts:201-204` today).
- `qa-agent.md` already has the "never report a raw secret value" line (`.claude/agents/qa-agent.md`, "What NOT to do" section) — round 1 already added it. Nothing to add there.
- `SKILL.md` line ~277 already has the extended absolute-path/secrets rule from round 1. It needs one more addition: a note that this rule now has a code-level backstop (the new hook), mirroring research-loop's own `ticket-refine/SKILL.md` addition.
- `main.ts` spawns `claude -p` with no `cwd` override (confirmed: `spawn("claude", args, { stdio: [...], env })` — no `cwd` key in either `spawnClaude` or `spawnClaudeStreaming`). This means `$CLAUDE_PROJECT_DIR` is fixed to dev-loop's own directory at hook-invocation time, exactly as research-loop verified for itself — the hook settings in `dev-loop/.claude/settings.json` apply regardless of which target-repo worktree the child later works in. This satisfies verification requirement #5 in the task prompt.
- Confirmed via live testing during planning (not assumed): `containsSecret()` does **not** false-positive on ordinary PR-body prose containing words like "OAuth", "authentication", "session", "token", "key" when they don't appear in a `NAME=value` or `"name": "value"` shape. Also confirmed the word-presence pre-filter (`grep -qw gh && grep -qw pr && grep -Eqw 'create|edit'`) correctly matches real `gh pr create`/`gh pr edit` invocations including multiline heredoc bodies, `--repo` flags, and env-var prefixes, and correctly rejects `gh pr view`, `gh issue create`, `gh api pulls`, and unrelated commands — this is the basis for Task 6's design.

## File Structure

- Modify: `src/redact.ts` — broaden `SECRET_NAME_PATTERN`, exclude `;` from `ENV_UNQUOTED_PATTERN`'s value class, add three bare-token patterns, add `URL_SHAPED_VALUE` guard, add `containsSecret()`, fix the known-env-value doc comment.
- Modify: `test/redact.test.ts` — add failing tests for every new pattern/function before implementing.
- Modify: `src/main.ts` — fix `truncate()`'s ordering in `printStreamEvent()`.
- Modify: `package.json` — add `engines.node`.
- Create: `scripts/check-secret-in-tool-input.ts` — pure `decideExitCode()` + a stdin-driven `main()`, scanning `tool_input.command` for a `gh pr create`/`gh pr edit` shape.
- Create: `test/check-secret-in-tool-input.test.ts` — vitest unit tests for `decideExitCode()`.
- Create: `.claude/hooks/block-secret-comments.sh` — the `PreToolUse` hook script: pre-filters on `gh`/`pr`/`create|edit` word presence via `jq`-extracted command, then invokes the checker.
- Create: `test/hooks/block-secret-comments.test.mjs` — end-to-end bash-driven test of the hook script (not wired into `npm test`, matching research-loop's own convention for anything outside vitest's scope).
- Create: `.claude/settings.json` — wires the hook to a `Bash`-matched `PreToolUse` entry.
- Modify: `CHANGELOG.md` — extend the existing 2026-09-01 entry with a "Round 2" section.
- Modify: `.claude/skills/ticket-to-pr/SKILL.md` — note the code-level backstop next to the existing secrets rule (~line 277-289).

---

### Task 1: Broaden `SECRET_NAME_PATTERN` and fix `ENV_UNQUOTED_PATTERN`'s value class

**Files:**
- Modify: `src/redact.ts:20-27` (the `SECRET_NAME_PATTERN` const and its doc comment), `src/redact.ts:51-52` (`ENV_UNQUOTED_PATTERN`)
- Test: `test/redact.test.ts`

**Interfaces:**
- Consumes: nothing new — same `redactSecrets(text: string): string` signature.
- Produces: `SECRET_NAME_PATTERN` now also matches `SIGNING_KEY`, `ACCOUNT_KEY`, `ROLE_KEY`, `ENCRYPTION_KEY`, a standalone `KEY` (anchored `^KEY$`, never a bare substring), `DSN`, `CONNECTION_STRING`, `CONN_STR`, `DATABASE_URL`, `DB_URL`, `URI`, `COOKIE`, `SESSION`, in addition to the existing `SECRET|TOKEN|API_KEY|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY|AUTH`. `ENV_UNQUOTED_PATTERN`'s value class now excludes `;` in addition to the existing `\s"{}[]`, used by Task 2's semicolon-segment tests.

- [ ] **Step 1: Write the failing tests**

Add to `test/redact.test.ts`, inside the existing `describe("redactSecrets", ...)` block (after the existing `github_token` test, before the `DATABASE_URL`/connection-string tests already present):

```ts
  it("redacts a SIGNING_KEY-named value", () => {
    expect(redactSecrets("SIGNING_KEY=abcdefghijklmnop")).toBe(
      "SIGNING_KEY=REDACTED_SECRET",
    );
  });

  it("redacts a bare KEY-named value", () => {
    expect(redactSecrets("KEY=abcdefghijklmnop")).toBe("KEY=REDACTED_SECRET");
  });

  it("does not treat issueIdOrKey as a secret-shaped name", () => {
    expect(redactSecrets('{"issueIdOrKey":"TARS-1301abcdefgh"}')).toBe(
      '{"issueIdOrKey":"TARS-1301abcdefgh"}',
    );
  });

  it("redacts a SUPABASE_SERVICE_ROLE_KEY-named value", () => {
    expect(redactSecrets("SUPABASE_SERVICE_ROLE_KEY=abcdefghijklmnop")).toBe(
      "SUPABASE_SERVICE_ROLE_KEY=REDACTED_SECRET",
    );
  });

  it("redacts a value under an ENCRYPTION_KEY-named var", () => {
    expect(redactSecrets("ENCRYPTION_KEY=abcdefghijklmnop")).toBe(
      "ENCRYPTION_KEY=REDACTED_SECRET",
    );
  });

  it("redacts a COOKIE-named value", () => {
    expect(redactSecrets("COOKIE=abcdefghijklmnop")).toBe(
      "COOKIE=REDACTED_SECRET",
    );
  });

  it("redacts a SESSION-named value", () => {
    expect(redactSecrets("SESSION=abcdefghijklmnop")).toBe(
      "SESSION=REDACTED_SECRET",
    );
  });
```

Note: the `issueIdOrKey` non-match test is the regression that matters most — it's the exact false positive research-loop's own TDD process caught with a bare `KEY` substring match. It must pass with the anchored `^KEY$` pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the new `SIGNING_KEY`/bare-`KEY`/`SUPABASE_SERVICE_ROLE_KEY`/`ENCRYPTION_KEY`/`COOKIE`/`SESSION` tests FAIL (current `SECRET_NAME_PATTERN` doesn't match those names) — the `issueIdOrKey` test currently PASSES (nothing matches it today), which is fine; it's a regression guard for Step 3, not a red test.

- [ ] **Step 3: Implement the minimal change**

In `src/redact.ts`, replace the `SECRET_NAME_PATTERN` const and its doc comment:

```ts
/**
 * Name fragment shared by every env-var name this module treats as
 * secret-shaped -- deliberately broad (matches CLIENT_SECRET, API_KEY,
 * JIRA_API_TOKEN, PRIVATE_KEY, etc.) since a false positive here just
 * redacts a value that wasn't actually sensitive, while a false negative
 * leaks a real credential. That said, this pattern is NOT a bare `KEY`
 * wildcard -- an earlier draft used one and it matched `issueIdOrKey`, a
 * field present on nearly every Jira API call/response, which would make
 * containsSecret() (see below) deny legitimate calls. `KEY` here is
 * deliberately anchored to compound forms (`SIGNING_KEY`, `ACCOUNT_KEY`,
 * etc.) and a standalone `^KEY$` case, never an unanchored substring.
 */
const SECRET_NAME_PATTERN =
  /SECRET|TOKEN|API[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL|ACCESS[_-]?KEY|AUTH|SIGNING[_-]?KEY|ACCOUNT[_-]?KEY|ROLE[_-]?KEY|ENCRYPTION[_-]?KEY|^KEY$|DSN|CONNECTION[_-]?STRING|CONN[_-]?STR|DATABASE[_-]?URL|DB[_-]?URL|URI|COOKIE|SESSION/i;
```

And update `ENV_UNQUOTED_PATTERN` (keep `ENV_QUOTED_PATTERN` unchanged):

```ts
const ENV_UNQUOTED_PATTERN =
  /((?:export\s+)?\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*)([^\s;"{}[\]]+)/g;
```

(Adds `;` to the excluded-character class, alongside the existing `\s`, `"`, `{`, `}`, `[`, `]`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass, including the new ones and the `issueIdOrKey` regression guard. Also re-run the full suite to confirm no existing test (e.g. `PORT=5001,3000` non-secret test) broke from the `;`-exclusion change — it shouldn't, since that test has no semicolon.

- [ ] **Step 5: Commit**

```bash
git add src/redact.ts test/redact.test.ts
git commit -m "redact: broaden SECRET_NAME_PATTERN, exclude ; from unquoted env value class"
```

---

### Task 2: Semicolon-delimited connection-string segment redaction

**Files:**
- Modify: none in `src/redact.ts` (this is a consequence of Task 1's `;`-exclusion, being verified explicitly)
- Test: `test/redact.test.ts`

**Interfaces:**
- Consumes: `redactSecrets` from Task 1 (unchanged signature).
- Produces: nothing new — this task is pure verification that Task 1's `;`-exclusion actually delivers the semicolon-delimited-connection-string behavior the task prompt calls for, with its own regression tests.

- [ ] **Step 1: Write the failing tests**

Add to `test/redact.test.ts`, in `describe("redactSecrets", ...)`:

```ts
  it("redacts a semicolon-delimited connection-string Password segment", () => {
    expect(
      redactSecrets("Server=myhost;Password=abcdefghijklmnop;Timeout=30"),
    ).toBe("Server=myhost;Password=REDACTED_SECRET;Timeout=30");
  });

  it("redacts a semicolon-delimited connection-string AccountKey segment", () => {
    expect(
      redactSecrets(
        "DefaultEndpointsProtocol=https;AccountKey=abcdefghijklmnop;EndpointSuffix=core.windows.net",
      ),
    ).toBe(
      "DefaultEndpointsProtocol=https;AccountKey=REDACTED_SECRET;EndpointSuffix=core.windows.net",
    );
  });

  it("does not touch a non-secret semicolon-delimited segment", () => {
    expect(redactSecrets("Server=myhost;Timeout=30")).toBe(
      "Server=myhost;Timeout=30",
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail or pass**

Run: `npm test`
Expected: these should already PASS if Task 1's `;`-exclusion was implemented correctly (this task is a verification/regression-lock, not new behavior) — if any FAIL, Task 1's implementation has a bug; fix `ENV_UNQUOTED_PATTERN` before proceeding, do not move on with a red test here.

- [ ] **Step 3: N/A — no implementation change if Step 2 passed**

If Step 2 failed, return to Task 1 and fix `ENV_UNQUOTED_PATTERN`'s character class, then re-run.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add test/redact.test.ts
git commit -m "redact: lock in semicolon-delimited connection-string segment redaction"
```

---

### Task 3: Bare-token format backstops (Stripe/GitHub/Slack) + `containsSecret()`

**Files:**
- Modify: `src/redact.ts` (add three new pattern consts, wire them into `redactSecrets()`, add `containsSecret()`)
- Test: `test/redact.test.ts`

**Interfaces:**
- Consumes: `redactSecrets(text: string): string` (existing).
- Produces: `export function containsSecret(text: string): boolean` — new. `redactSecrets` now also redacts Stripe (`sk_live_`/`rk_live_`/`pk_live_`), GitHub (`gh[oprsu]_`), and Slack (`xox[baprs]-`) bare tokens regardless of surrounding name/context. Task 6's hook checker imports `containsSecret` from this exact path (`../src/redact.ts` relative to `scripts/`).

- [ ] **Step 1: Write the failing tests**

Add to `test/redact.test.ts`, in `describe("redactSecrets", ...)` (after the existing JWT test):

```ts
  it("redacts a bare Stripe-shaped secret key with no matching var name", () => {
    expect(
      redactSecrets(
        "using key sk_live_51H8xabcdefghijklmnopqrstuvwxyz which is hardcoded",
      ),
    ).toBe("using key REDACTED_SECRET which is hardcoded");
  });

  it("redacts a bare GitHub-shaped token with no matching var name", () => {
    expect(
      redactSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    ).toBe("token: REDACTED_SECRET");
  });

  it("redacts a bare Slack-shaped token with no matching var name", () => {
    expect(
      redactSecrets("webhook uses xoxb-1234567890-abcdefghijklmnop"),
    ).toBe("webhook uses REDACTED_SECRET");
  });

  it("never throws on non-string input", () => {
    // @ts-expect-error -- deliberately testing runtime defensiveness against bad input
    expect(() => redactSecrets(null)).not.toThrow();
  });
```

Add a new top-level `describe` block, after `describe("redactSecrets", ...)` and before `describe("redactSensitive", ...)`:

```ts
describe("containsSecret", () => {
  it("returns true for a secret-shaped NAME=value line", () => {
    expect(containsSecret("CLIENT_SECRET=abcdefghijklmnop")).toBe(true);
  });

  it("returns true for a secret-shaped JSON value", () => {
    expect(containsSecret('{"apiKey":"abcdefghijklmnop"}')).toBe(true);
  });

  it("returns true for a bare AWS-shaped key", () => {
    expect(containsSecret("AKIAABCDEFGHIJKLMNOP")).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(containsSecret("PORT=5001, NODE_ENV=development")).toBe(false);
  });

  it("returns false, not a throw, on empty input", () => {
    expect(() => containsSecret("")).not.toThrow();
    expect(containsSecret("")).toBe(false);
  });

  it("returns false, not a throw, on non-string input", () => {
    // @ts-expect-error -- deliberately testing runtime defensiveness against bad input
    expect(() => containsSecret(null)).not.toThrow();
    // @ts-expect-error -- deliberately testing runtime defensiveness against bad input
    expect(containsSecret(undefined)).toBe(false);
  });
});
```

Update the top import line in `test/redact.test.ts`:

```ts
import { redactPII, redactSecrets, redactSensitive, containsSecret } from "../src/redact.ts";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the Stripe/GitHub/Slack tests and all `containsSecret` tests FAIL (`containsSecret` doesn't exist yet — import error). The non-string-input test currently PASSES already (existing `redactSecrets` never throws) — that's fine, it's a regression lock.

- [ ] **Step 3: Implement the minimal change**

In `src/redact.ts`, after the existing `JWT_PATTERN` const, add:

```ts
/**
 * Bare-token format backstops, same confidence bar as AWS_KEY_PATTERN/
 * JWT_PATTERN above: recognizable by shape alone, no NAME= prefix needed.
 * These target the highest-frequency "secret pasted in prose with no key
 * name nearby" shape (e.g. "...using key sk_live_51H8x... which is
 * hardcoded") -- the one leak shape no NAME=value pattern can catch,
 * since there's no name to anchor on.
 */
const STRIPE_KEY_PATTERN = /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}\b/g;
const GITHUB_TOKEN_PATTERN = /\bgh[oprsu]_[A-Za-z0-9]{16,}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
```

In `redactSecrets()`, after the existing `result = result.replace(JWT_PATTERN, "REDACTED_SECRET");` line, add:

```ts
  result = result.replace(STRIPE_KEY_PATTERN, "REDACTED_SECRET");
  result = result.replace(GITHUB_TOKEN_PATTERN, "REDACTED_SECRET");
  result = result.replace(SLACK_TOKEN_PATTERN, "REDACTED_SECRET");
```

Add a non-string guard at the top of `redactSecrets()` (the existing function currently has no such guard — the task prompt's `containsSecret` requirement needs it, and the new `@ts-expect-error` test exercises it directly):

```ts
export function redactSecrets(text: string): string {
  if (typeof text !== "string") return "";
  let result = text;
  // ... existing body unchanged
```

At the end of the file, after `redactSecrets` and before `redactSensitive`, add:

```ts
/**
 * Boolean check reusing redactSecrets's own patterns -- true if `text`
 * contains anything redactSecrets would redact, false otherwise. This is
 * what the .claude/hooks/block-secret-comments.sh hook (via
 * scripts/check-secret-in-tool-input.ts) uses to decide whether to deny a
 * `gh pr create`/`gh pr edit` Bash call, so this is intentionally the
 * *same* detection logic as redactSecrets, not a second, drifting
 * reimplementation. Pure, defensive: never throws, and returns false
 * rather than throwing when there's nothing to check.
 */
export function containsSecret(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return redactSecrets(text) !== text;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/redact.ts test/redact.test.ts
git commit -m "redact: add Stripe/GitHub/Slack bare-token backstops and containsSecret()"
```

---

### Task 4: URL-shaped-value skip guard (prevents `DATABASE_URL`/`URI` regression)

**Files:**
- Modify: `src/redact.ts` (`redactQuoted`/`redactUnquoted` closures, or their equivalent after Task 1's changes)
- Test: `test/redact.test.ts` (existing `DATABASE_URL` tests already present — this task's job is to make sure Task 1's broadened pattern doesn't break them)

**Interfaces:**
- Consumes: `isRedactableValue`, `redactQuoted`, `redactUnquoted` (existing internal closures in `redactSecrets()`).
- Produces: no new exports — internal fix only.

- [ ] **Step 1: Confirm the regression exists (write/check the test first)**

The existing tests at `test/redact.test.ts` (already present, from round 1):

```ts
  it("redacts embedded credentials in a connection-string/DSN value", () => {
    expect(
      redactSecrets("DATABASE_URL=postgres://user:pass@host:5432/db"),
    ).toBe("DATABASE_URL=postgres://REDACTED_SECRET@host:5432/db");
  });

  it("leaves a connection-string value with no embedded credentials untouched", () => {
    expect(redactSecrets("postgres://host:5432/db")).toBe(
      "postgres://host:5432/db",
    );
  });
```

These already exist — do not duplicate them. Just run the suite now, after Task 1's `DATABASE_URL`/`URI` addition to `SECRET_NAME_PATTERN`, to see if they still pass.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: `"redacts embedded credentials in a connection-string/DSN value"` FAILS now — because `DATABASE_URL` newly matches `SECRET_NAME_PATTERN` (added in Task 1), the generic `ENV_UNQUOTED_PATTERN` pass now redacts the *entire* `postgres://user:pass@host:5432/db` value as `DATABASE_URL=REDACTED_SECRET` before `CONNECTION_STRING_CREDENTIALS_PATTERN` (which runs later and expects an un-redacted `user:pass@` segment) ever sees it. Confirm this is the actual failure (read the assertion diff), not a coincidental unrelated failure.

- [ ] **Step 3: Implement the minimal change**

In `src/redact.ts`, add a new const near `MIN_PATTERN_VALUE_LENGTH`:

```ts
/** Matches a value that's itself a URL (`scheme://...`) -- see the skip
 * check in redactQuoted/redactUnquoted below for why. */
const URL_SHAPED_VALUE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
```

In both `redactQuoted` and `redactUnquoted` closures inside `redactSecrets()`, add a check before the final redaction return, right after the existing `isRedactableValue` check:

```ts
  const redactQuoted = (
    match: string,
    prefix: string,
    name: string,
    value: string,
  ): string => {
    if (!SECRET_NAME_PATTERN.test(name)) return match;
    if (!isRedactableValue(value)) return match;
    if (URL_SHAPED_VALUE.test(value)) return match;
    return `${prefix}"REDACTED_SECRET"`;
  };

  const redactUnquoted = (
    match: string,
    prefix: string,
    name: string,
    value: string,
  ): string => {
    if (!SECRET_NAME_PATTERN.test(name)) return match;
    if (!isRedactableValue(value)) return match;
    if (URL_SHAPED_VALUE.test(value)) return match;
    return `${prefix}REDACTED_SECRET`;
  };
```

This makes the generic name/value pass skip any URL-shaped value entirely, leaving `CONNECTION_STRING_CREDENTIALS_PATTERN` (which runs later, unconditionally) as the sole handler for URL-shaped values — it redacts only the embedded `user:pass@` segment and leaves the rest of the URL intact.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: both `DATABASE_URL` tests pass again, full suite green (122 + all new tests from Tasks 1-3).

- [ ] **Step 5: Commit**

```bash
git add src/redact.ts
git commit -m "redact: skip URL-shaped values in the generic name/value pass, fixing a DATABASE_URL regression"
```

---

### Task 5: Fix truncate-before-redact ordering bug in `src/main.ts`

**Files:**
- Modify: `src/main.ts:201-204` (the `truncate` helper inside `printStreamEvent`)

**Interfaces:**
- Consumes: `redactSensitive` (already imported at the top of `main.ts`).
- Produces: no signature change to `printStreamEvent` or `truncate` — same call sites, fixed internal ordering.

This file has no vitest coverage by design (per its own header comment: "this is the real-IO wiring that fakes stand in for"). Verify this fix by hand, not via a new automated test.

- [ ] **Step 1: Read the current buggy code to confirm the exact lines**

Current `src/main.ts:200-204`:

```ts
function printStreamEvent(parsed: unknown, ticketKey: string): void {
  const truncate = (value: unknown): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 200)}...` : text;
  };
```

- [ ] **Step 2: Implement the fix**

Replace with:

```ts
function printStreamEvent(parsed: unknown, ticketKey: string): void {
  // Redact *before* truncating, not after: a secret cut mid-value by
  // truncation loses its closing quote, so redact.ts's patterns (which
  // require a real closing quote/delimiter) never match the now-unquoted
  // prefix, and it prints in the clear. log() below also runs
  // redactSensitive() on the final line -- harmless, since re-redacting
  // an already-substituted REDACTED_SECRET string is a no-op.
  const truncate = (value: unknown): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const redacted = redactSensitive(text);
    return redacted.length > 200 ? `${redacted.slice(0, 200)}...` : redacted;
  };
```

- [ ] **Step 3: Manual repro — verify the fix by hand**

Run this standalone repro (not part of the automated suite, per the file's no-vitest-coverage design):

```bash
node -e '
import("./src/redact.ts").then(({ redactSensitive }) => {
  const secret = "sk_live_" + "a".repeat(190); // straddles the 200-char boundary
  const text = `using key ${secret} in config`;

  // OLD (buggy) order: truncate first, then redact
  const oldTruncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
  const oldResult = redactSensitive(oldTruncated);
  console.log("OLD order result (should leak a fragment):", oldResult.includes(secret.slice(0, 50)) ? "LEAKS" : "clean");

  // NEW (fixed) order: redact first, then truncate
  const redacted = redactSensitive(text);
  const newResult = redacted.length > 200 ? redacted.slice(0, 200) + "..." : redacted;
  console.log("NEW order result (must be clean):", newResult.includes(secret.slice(0, 50)) ? "LEAKS" : "clean");
  console.log("NEW result:", newResult);
});
'
```

Expected output: `OLD order result: LEAKS`, `NEW order result: clean`, and the NEW result line shows `REDACTED_SECRET` in place of the key, not a truncated fragment of it.

- [ ] **Step 4: Run the full test suite to confirm nothing broke**

Run: `npm test`
Expected: all tests still green (this file has no direct test coverage, so this just confirms the change didn't break an import or syntax).

Run: `npm run build`
Expected: clean, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "main: redact stream-event values before truncating, not after"
```

---

### Task 6: New hook — deny `gh pr create`/`gh pr edit` Bash calls carrying a secret

This is the task the prompt explicitly flagged as needing fresh design. The matcher problem is different from research-loop's (recognizing a `Bash` command line vs. a fixed MCP tool name), verified empirically during planning:

- **Design decision (documented, not just chosen)**: pre-filter in the bash hook script itself, via three independent word-presence checks (`grep -qw gh`, `grep -qw pr`, `grep -Eqw 'create|edit'` against the extracted command string) — cheaper per-`Bash`-call than invoking Node on every single one, since this hook's matcher fires on `Bash` (used constantly for git/test/lint/build commands throughout every phase), unlike research-loop's matcher which only fires on the much rarer Jira/Confluence MCP write calls.
- Independent substring/word checks were chosen over a single combined regex with `.*` between the words: empirical testing during planning showed a single regex like `\bgh\b.*\bpr\b.*\b(create|edit)\b` fails to match when the words land on different lines (e.g. a line-continued command, or — more subtly — some heredoc body layouts), because `.` doesn't match `\n` by default. Three independent `grep -w` checks against the whole (newline-preserved) command string have no such gap: each word only needs to appear anywhere as a whole word, which is true for every real `gh pr create`/`gh pr edit` invocation regardless of line-wrapping, and empirically still correctly rejects `gh pr view`, `gh issue create`, `gh api pulls`, and unrelated commands (`ghost pr create` does not false-positive since `grep -w` requires whole-word boundaries).
- This pre-filter is a cheap membership check, not the security boundary — the actual secret scan (`containsSecret()` via the Node checker) still runs on the full command string whenever the pre-filter passes, and the pre-filter erring toward over-matching (e.g. matching `gh pr create` mentioned inside an unrelated echo/string literal) is harmless: it just costs one extra Node invocation, never a missed detection.

**Files:**
- Create: `scripts/check-secret-in-tool-input.ts`
- Create: `test/check-secret-in-tool-input.test.ts`
- Create: `.claude/hooks/block-secret-comments.sh`
- Create: `test/hooks/block-secret-comments.test.mjs`
- Create: `.claude/settings.json`

**Interfaces:**
- Consumes: `containsSecret` from `src/redact.ts` (Task 3).
- Produces: `export function decideExitCode(stdin: string): 0 | 1 | 2` in `scripts/check-secret-in-tool-input.ts`, unit-tested directly; the script's own `main()` maps that to process exit codes `0`/`3`/`2` (never `1`, to avoid colliding with Node's own default uncaught-crash exit code). `.claude/hooks/block-secret-comments.sh` is invoked by Claude Code as the `PreToolUse` hook for the `Bash` matcher, reading the tool-call JSON from stdin and exiting `0` (allow) or `2` (deny).

- [ ] **Step 1: Write the failing checker unit tests**

Create `test/check-secret-in-tool-input.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decideExitCode } from "../scripts/check-secret-in-tool-input.ts";

describe("decideExitCode", () => {
  it("exits 0 for a clean gh pr create command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --title "TARS-1: fix" --body "## Changes\n- clean"',
      },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 1 for a secret-shaped value in a gh pr create command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --title "TARS-1" --body "found CLIENT_SECRET=abcdefghijklmnop hardcoded"',
      },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 1 for a secret-shaped value in a gh pr edit command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh pr edit 123 --body 'SIGNING_KEY=abcdefghijklmnop'" },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 0 for a non-gh command, even if it contains secret-shaped text", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "echo CLIENT_SECRET=abcdefghijklmnop >> notes.txt" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for gh pr view, even with secret-shaped text present", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh pr view 42 # CLIENT_SECRET=abcdefghijklmnop" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for gh issue create, not a pr command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh issue create --title CLIENT_SECRET=abcdefghijklmnop" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 when tool_name is not Bash", () => {
    const stdin = JSON.stringify({
      tool_name: "Read",
      tool_input: { command: "gh pr create --body CLIENT_SECRET=abcdefghijklmnop" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 when tool_input.command is missing", () => {
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: {} });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for empty stdin", () => {
    expect(decideExitCode("")).toBe(0);
  });

  it("exits 0 for whitespace-only stdin", () => {
    expect(decideExitCode("   \n  ")).toBe(0);
  });

  it("exits 2 for malformed (non-JSON) stdin", () => {
    expect(decideExitCode("{not valid json")).toBe(2);
  });

  it("exits 2 for non-string input", () => {
    // @ts-expect-error -- deliberately testing runtime defensiveness against bad input
    expect(decideExitCode(null)).toBe(2);
  });

  it("treats a command containing shell metacharacters as plain text data, never as code", () => {
    const adversarial = 'gh pr create --body "`rm -rf /` ${process.exit(1)} \\"; require(\'child_process\').execSync(\'touch /tmp/pwned\'); //"';
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: adversarial } });
    expect(() => decideExitCode(stdin)).not.toThrow();
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("still detects a secret hidden inside adversarial shell-metacharacter text", () => {
    const adversarial = 'gh pr create --body "`echo hi` and CLIENT_SECRET=abcdefghijklmnop ${ignored}"';
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: adversarial } });
    expect(decideExitCode(stdin)).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with a module-not-found error (`scripts/check-secret-in-tool-input.ts` doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/check-secret-in-tool-input.ts`:

```ts
/**
 * PreToolUse hook checker invoked by .claude/hooks/block-secret-comments.sh
 * for every Bash call the hook's pre-filter recognizes as a `gh pr create`/
 * `gh pr edit` invocation. Reads the hook's stdin JSON payload, extracts
 * tool_input.command, and scans it for anything containsSecret() would
 * flag. Communicates its verdict purely via exit code -- no stdout, so
 * nothing it prints can itself become a leak channel:
 *
 *   0 -- clean: not a gh pr create/edit call, or no secret-shaped content.
 *   1 -- secret-shaped content found in a gh pr create/edit command.
 *   2 -- the check itself failed (malformed/non-JSON stdin, unexpected
 *        exception) -- distinct from "found a secret" so the calling hook
 *        script fails *closed* (deny) on this case too, rather than
 *        silently treating "couldn't tell" the same as "found nothing".
 *
 * The command string is read here purely as JSON *data* (via JSON.parse on
 * a string read from stdin) -- never interpolated into a shell command or
 * a dynamically-built source string. This matters because the command
 * string can itself contain the PR body text (e.g. `gh pr create --body
 * "..."`), and PR/ticket content is adversarially-influenceable -- backtick
 * s/${}/quotes in it must never be able to execute as code in this
 * process, which has this repo's real credentials in its environment.
 */

import { containsSecret } from "../src/redact.ts";

/**
 * Whole-word membership check -- matches the shell pre-filter's own
 * `grep -qw` logic, kept here too so the unit tests can exercise the
 * gh-pr-create/edit recognition directly without spawning bash. Not a
 * security boundary by itself (see the hook script's own header comment
 * for why over-matching here is harmless) -- just the recognizer for
 * "is this command actually a gh pr create/edit invocation."
 */
function isGhPrWrite(command: string): boolean {
  const hasWord = (word: string): boolean =>
    new RegExp(`(?:^|\\W)${word}(?:$|\\W)`).test(command);
  return hasWord("gh") && hasWord("pr") && (hasWord("create") || hasWord("edit"));
}

/**
 * Pure decision function, unit-testable without touching stdin/process.
 * `stdin` is the raw JSON string the hook receives from Claude Code.
 */
export function decideExitCode(stdin: string): 0 | 1 | 2 {
  if (typeof stdin !== "string") return 2;
  if (stdin.trim().length === 0) return 0;

  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return 2;
  }

  try {
    const record = payload as Record<string, unknown> | null;
    if (record?.tool_name !== "Bash") return 0;
    const toolInput = record?.tool_input as Record<string, unknown> | null | undefined;
    const command = toolInput?.command;
    if (typeof command !== "string" || command.length === 0) return 0;
    if (!isGhPrWrite(command)) return 0;
    return containsSecret(command) ? 1 : 0;
  } catch {
    return 2;
  }
}

/**
 * Maps decideExitCode's internal 0|1|2 contract to the actual process exit
 * code, deliberately choosing 3 (not 1) for "secret found" -- Node's own
 * default exit code for a totally uncaught crash (a syntax error, or a
 * module-load-time throw, happening before any in-process handler below
 * even runs) is 1. If "secret found" also used 1, a completely broken
 * checker crashing would be indistinguishable from one that correctly
 * found a secret, misleading whoever reads the denial reason. Any exit
 * code other than 0 or 3 reliably means "something about the check
 * failed," regardless of how it failed.
 */
const PROCESS_EXIT_CODE = { 0: 0, 1: 3, 2: 2 } as const;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const stdin = Buffer.concat(chunks).toString("utf8");
  process.exit(PROCESS_EXIT_CODE[decideExitCode(stdin)]);
}

// Only run as a script when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  // Belt-and-suspenders fail-closed guard: an exception anywhere in this
  // process must still report exit code 2 ("check failed"), never fall
  // through to whatever exit code Node happens to produce on its own.
  process.on("uncaughtException", () => process.exit(2));
  process.on("unhandledRejection", () => process.exit(2));
  main().catch(() => process.exit(2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all `decideExitCode` tests pass, full suite green.

Run: `npm run build`
Expected: clean.

- [ ] **Step 5: Write the failing end-to-end hook test**

Create `test/hooks/block-secret-comments.test.mjs` (mirrors research-loop's own convention: standalone script, not wired into `npm test`/vitest, since it drives a real child process):

```js
// End-to-end test of .claude/hooks/block-secret-comments.sh, driven via
// real piped stdin JSON the same shape Claude Code sends a PreToolUse
// hook for a Bash tool call. Run standalone with:
//   node test/hooks/block-secret-comments.test.mjs
// (not wired into npm test/vitest -- this drives an actual child
// process/bash script, not an in-process unit.)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync, renameSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const HOOK_PATH = join(REPO_ROOT, ".claude", "hooks", "block-secret-comments.sh");

let failures = 0;

function runHook(stdinJson, env = {}) {
  return spawnSync("bash", [HOOK_PATH], {
    input: stdinJson,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, ...env },
  });
}

function check(name, condition, detail) {
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
  }
}

// --- Case 1: secret-shaped gh pr create body is denied ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: 'gh pr create --title "TARS-1" --body "CLIENT_SECRET=abcdefghijklmnop found hardcoded"' },
  });
  const result = runHook(stdin);
  check("secret-shaped gh pr create: exit code is 2", result.status === 2, `got ${result.status}`);
  check("secret-shaped gh pr create: stderr is non-empty", result.stderr.trim().length > 0);
  check(
    "secret-shaped gh pr create: stderr does not contain the actual secret value",
    !result.stderr.includes("abcdefghijklmnop"),
    result.stderr,
  );
}

// --- Case 2: clean gh pr create body is allowed ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: 'gh pr create --title "TARS-1" --body "## Changes\n- clean change"' },
  });
  const result = runHook(stdin);
  check("clean gh pr create: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

// --- Case 3: unrelated Bash command (e.g. npm test) is allowed without invoking the checker at all ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  const result = runHook(stdin);
  check("unrelated Bash command: exit code is 0", result.status === 0, `got ${result.status}`);
}

// --- Case 4: gh pr view (not create/edit) is allowed even with secret-shaped text present ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "gh pr view 42 # CLIENT_SECRET=abcdefghijklmnop" },
  });
  const result = runHook(stdin);
  check("gh pr view: exit code is 0", result.status === 0, `got ${result.status}`);
}

// --- Case 5: simulated checker crash fails closed (exit 2), with a distinct reason ---
{
  const brokenCheckerPath = join(REPO_ROOT, "scripts", "__test_broken_checker__.ts");
  writeFileSync(brokenCheckerPath, "throw new Error('simulated checker crash');\n");
  const realCheckerPath = join(REPO_ROOT, "scripts", "check-secret-in-tool-input.ts");
  const backupPath = join(REPO_ROOT, "scripts", "__check-secret-in-tool-input.ts.bak");
  try {
    renameSync(realCheckerPath, backupPath);
    try {
      renameSync(brokenCheckerPath, realCheckerPath);
      const stdin = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh pr create --body irrelevant" },
      });
      const result = runHook(stdin);
      check("checker-failure: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}`);
      check(
        "checker-failure: stderr reason is distinguishable from the secret-found reason",
        result.stderr.includes("could not verify"),
        result.stderr,
      );
    } finally {
      renameSync(realCheckerPath, brokenCheckerPath);
      renameSync(backupPath, realCheckerPath);
    }
  } finally {
    try {
      unlinkSync(brokenCheckerPath);
    } catch {
      // already cleaned up above
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll checks passed.");
}
```

- [ ] **Step 6: Run the end-to-end test to verify it fails**

Run: `node test/hooks/block-secret-comments.test.mjs`
Expected: FAIL (`.claude/hooks/block-secret-comments.sh` doesn't exist yet — bash will report "No such file or directory" and `spawnSync` returns a non-2/0 status, so the case checks fail).

- [ ] **Step 7: Write the minimal implementation**

Create `.claude/hooks/block-secret-comments.sh`:

```bash
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
```

Make it executable:

```bash
chmod +x .claude/hooks/block-secret-comments.sh
```

Create `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/block-secret-comments.sh"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 8: Run the end-to-end test to verify it passes**

Run: `node test/hooks/block-secret-comments.test.mjs`
Expected: `All checks passed.`, exit code 0.

- [ ] **Step 9: Run the full test suite and build**

Run: `npm test`
Expected: full suite green (unchanged — the `.mjs` test isn't part of vitest's `include` glob).

Run: `npm run build`
Expected: clean.

- [ ] **Step 10: Verify the hook actually fires in a real Claude Code invocation**

This is verification requirement #5 from the task prompt — confirm the hook fires for real, not just in the standalone bash test. From the dev-loop repo root:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"gh pr create --title \"test\" --body \"CLIENT_SECRET=abcdefghijklmnop\""}}' | claude --print --model sonnet --permission-mode acceptEdits --allowedTools "Bash" -p "Run this exact Bash command: echo hi" 2>&1 | head -20
```

(This step is a sanity check that Claude Code's own hook loader picks up `.claude/settings.json` from the current working directory — since `src/main.ts` spawns `claude -p` with `cwd` unset, i.e. inherited from the Node process's own cwd, which is dev-loop's repo root whenever `npm run loop` is invoked from there. Confirm the actual test command above triggers a visible permission-denial in the output, or adapt to whatever direct hook-testing mechanism is available; the goal is empirical confirmation, not just reading the settings file.)

- [ ] **Step 11: Commit**

```bash
git add scripts/check-secret-in-tool-input.ts test/check-secret-in-tool-input.test.ts .claude/hooks/block-secret-comments.sh test/hooks/block-secret-comments.test.mjs .claude/settings.json
git commit -m "Add PreToolUse hook denying secret-shaped content in gh pr create/edit calls"
```

---

### Task 7: Pin `engines.node` in `package.json`

**Files:**
- Modify: `package.json`

**Interfaces:** none — config-only change.

- [ ] **Step 1: No test needed** (this is a metadata-only change with no runtime behavior to assert in vitest)

- [ ] **Step 2: Implement**

In `package.json`, add `engines` after `"type": "module",`:

```json
{
  "name": "dev-loop",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.18.0"
  },
  "scripts": {
```

- [ ] **Step 3: Verify**

Run: `node --version` — confirm it's `>=22.18.0` on this machine (already confirmed during planning: `v24.16.0`).
Run: `npm test && npm run build` — confirm both still pass/clean (adding `engines` doesn't change npm's own behavior unless `engine-strict` is set, which it isn't here).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "package.json: pin engines.node to >=22.18.0"
```

---

### Task 8: Documentation — CHANGELOG.md, SKILL.md

**Files:**
- Modify: `CHANGELOG.md` (extend the existing `## 2026-09-01` entry with a new subsection)
- Modify: `.claude/skills/ticket-to-pr/SKILL.md` (note the code-level backstop near line 277-289)

`qa-agent.md` already has the round-1 "never report a raw secret value" line (confirmed present during planning) — nothing to add there this round.

**Interfaces:** none — docs only.

- [ ] **Step 1: No test needed** (docs-only change)

- [ ] **Step 2: Extend `CHANGELOG.md`**

In `CHANGELOG.md`, immediately after the existing `### Follow-up the same day — ...` subsection (which ends with "Flag for a future pass only if actually observed leaking in a real run.") and before the next `## 2026-08-27` entry, insert:

```markdown
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
```

- [ ] **Step 3: Add the SKILL.md note**

In `.claude/skills/ticket-to-pr/SKILL.md`, find the existing sentence (already present from round 1, near line 277-289):

```
Report presence/shape only, mirroring whatever `hasClientSecret`/length-only pattern the
target repo's own app logging already uses (e.g. "reads `API_KEY` from
env" or "token present, 42 chars"), never the literal value.
```

Add immediately after it (still within the same numbered list item, before item 3 begins):

```markdown
   **This rule now has a code-level backstop** — a `PreToolUse` hook
   (`.claude/hooks/block-secret-comments.sh`) denies any `gh pr create`/
   `gh pr edit` command whose content matches a known secret name or
   format pattern (see `CHANGELOG.md`'s "Round 2" entry) — but that hook
   is a heuristic backstop, not a replacement for following this rule; it
   won't catch every shape a secret could take.
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run build` — confirm docs-only changes didn't break anything (should be a no-op check, but confirms nothing else was accidentally touched).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md .claude/skills/ticket-to-pr/SKILL.md
git commit -m "docs: record round-2 secret-redaction hardening and the new PreToolUse hook"
```

---

### Task 9: Final full verification pass

**Files:** none modified — verification only.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests green — the original 122 baseline plus every test added in Tasks 1, 2, 3, 6.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean, no TypeScript errors.

- [ ] **Step 3: Hook end-to-end test**

Run: `node test/hooks/block-secret-comments.test.mjs`
Expected: `All checks passed.`

- [ ] **Step 4: Manual truncate-fix repro (re-confirm, since Task 5 had no automated test)**

Re-run the repro script from Task 5, Step 3. Expected: `OLD order result: LEAKS`, `NEW order result: clean`.

- [ ] **Step 5: Confirm the hook doesn't block a normal, clean run**

This directly addresses the concern that this hardening must never cause the loop to bounce or stall on its own account, distinct from a real ticket problem. Run the hook script directly against a realistic clean PR body matching `SKILL.md`'s own template:

```bash
node -e '
const cmd = `gh pr create --title "TARS-1301: Fix null check" --body "$(cat <<EOF
## Changes
- Added null check for empty ticket description
- Updated tests to cover the empty-description case

## QA Notes
- Existing suite: 122 passed / 0 failed
- Lint/typecheck/build: clean
- QA agent: pass, verify_loops 1

---
[TARS-1301](https://fandango.atlassian.net/browse/TARS-1301)
EOF
)"`;
process.stdout.write(JSON.stringify({tool_name:"Bash", tool_input:{command: cmd}}));
' | CLAUDE_PROJECT_DIR="$(pwd)" bash .claude/hooks/block-secret-comments.sh; echo "exit=$?"
```

Expected: `exit=0` (allowed) — confirms the realistic template PR body from `SKILL.md` never trips the hook.

- [ ] **Step 6: No commit — this task is verification only**

If any step above fails, return to the relevant earlier task and fix before considering the plan complete.

---

## Self-Review Notes (from plan authoring)

- **Spec coverage**: all six numbered items in the task prompt map to tasks above — item 1 (redact.ts hardening) → Tasks 1-4; item 2 (truncate fix) → Task 5; item 3 (engines.node) → Task 7; item 4 (hook) → Task 6; item 5 (docs) → Task 8; verification items 1-5 → Task 9 (items 1-4) and Task 6 Step 10 (item 5, hook-firing confirmation).
- **Alignment with research-loop**: Tasks 1-5 and 7 are near-verbatim ports of already-shipped, already-tested research-loop code (commit `334ced5`), copied from the real files during planning rather than re-derived from the task prompt's markdown (whose inline regex examples lost underscores to markdown italics rendering — the plan uses the verified real patterns instead). This is mechanical work, not fresh design, by nature — the task prompt's own framing ("carry over these two hard-won, non-negotiable design points verbatim") confirms this is intentional for everything except Task 6's matcher.
- **Where dev-loop genuinely differs from research-loop** (Task 6 only): the write surface is `Bash` running `gh pr create`/`gh pr edit`, not a fixed MCP tool name — this required fresh matcher design (verified empirically during planning: independent word-presence checks over a combined regex, since the combined regex was empirically shown to miss real invocations whose words span multiple lines). The exit-code contract, fail-closed behavior, and stdin-only data handling are carried over verbatim per the task prompt's explicit instruction, since those are not research-loop-specific.
- **"Don't block the loop on us, not a genuine ticket problem"**: this is the guiding constraint behind Task 6's design and Task 9 Step 5. Two concrete safeguards: (a) the pre-filter is intentionally cheap and over-inclusive rather than under-inclusive — a false-positive pre-filter match just costs one extra Node invocation, never a wrongly-allowed write, while a false-negative would defeat the hook; (b) `containsSecret()` empirically does not false-positive on realistic PR-body prose (confirmed during planning against the exact template `SKILL.md` uses, including sentences containing "OAuth"/"authentication"/"session"/"key" as ordinary words). If the hook denies a *real* secret-shaped write, that is correct behavior — the resulting Bash-call denial is designed to be visible to the running `claude -p` process (via `permission_denials` in its own JSON output, already surfaced today at `src/main.ts:393-396`) so it can retry with a fixed (secret-free) PR body rather than the whole ticket dying with an opaque `agent_error`. This plan does not add any new `failure_category` — a hook denial during Phase 5 is recoverable within the same run (retry the `gh pr create`/`gh pr edit` call with corrected content) exactly the way any other transient Bash failure is today; it only becomes a bounce/error if the skill's own retry logic gives up, which is unchanged pre-existing behavior, not something this plan introduces.
- **No placeholders**: every step above has literal code, not a description of code — confirmed on self-review.
- **Type/name consistency**: `containsSecret`, `redactSecrets`, `redactSensitive`, `redactPII` signatures are consistent across Tasks 1-5 and Task 6's checker import. `decideExitCode`'s `0 | 1 | 2` return type and `PROCESS_EXIT_CODE` mapping are consistent between Task 6's implementation and its tests.
