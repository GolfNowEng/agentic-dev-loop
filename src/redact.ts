/**
 * Redacts PII (email addresses, and by extension any absolute path that
 * embeds one -- on machines where $HOME is email-shaped) from any string
 * before it's printed to a terminal or written to a log. Pure, defensive:
 * never throws, and a string with nothing to redact is returned unchanged.
 */

import { homedir } from "node:os";

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function redactPII(text: string): string {
  const home = homedir();
  let result = home ? text.replaceAll(home, "~") : text;
  result = result.replace(EMAIL_PATTERN, "REDACTED_EMAIL");
  return result;
}

/**
 * Name fragment shared by every env-var name this module treats as
 * secret-shaped -- deliberately broad (matches CLIENT_SECRET, API_KEY,
 * JIRA_API_TOKEN, PRIVATE_KEY, etc.) since a false positive here just
 * redacts a value that wasn't actually sensitive, while a false negative
 * leaks a real credential. That said, this pattern is NOT a bare `KEY`
 * wildcard -- an earlier draft used one and it matched `issueIdOrKey`,
 * a field present on essentially every Jira MCP tool call/response, which
 * would make `containsSecret()` (used by the PreToolUse hook, see
 * scripts/check-secret-in-tool-input.ts) deny every single legitimate
 * Jira write. For `redactSecrets()`'s own use (turning a value into
 * REDACTED_SECRET) an over-broad match is cheap; for `containsSecret()`'s
 * use (denying a whole tool call) it is not, so `KEY` here is deliberately
 * anchored to compound forms and a small explicit set of common
 * standalone names, not left as an unanchored substring match.
 */
const SECRET_NAME_PATTERN =
  /SECRET|TOKEN|API[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL|ACCESS[_-]?KEY|AUTH|SIGNING[_-]?KEY|ACCOUNT[_-]?KEY|ROLE[_-]?KEY|ENCRYPTION[_-]?KEY|^KEY$|DSN|CONNECTION[_-]?STRING|CONN[_-]?STR|DATABASE[_-]?URL|DB[_-]?URL|URI|COOKIE|SESSION/i;

/**
 * `NAME="value"` / `export NAME="value"` -- env-style, quoted. The value
 * group requires a real closing quote (JSON/shell-escape aware, so an
 * escaped `\"` inside the value doesn't terminate the match early) --
 * critical so a value containing a comma or brace is captured whole
 * instead of leaving a truncated remainder that corrupts JSON downstream
 * (verdictRaw in main.ts is fed straight into JSON.parse()).
 */
// Name capture allows lower/mixed case (env vars are conventionally
// UPPER_SNAKE_CASE, but a target repo's own .envrc or shell script can and
// does use `github_token=`/`clientSecret=`-style names too -- matching
// case-sensitively would silently miss those).
const ENV_QUOTED_PATTERN =
  /((?:export\s+)?\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*)"((?:[^"\\]|\\.)*)"/g;

/** `NAME=value` / `export NAME=value` -- env-style, unquoted. Excludes
 * `{`/`[` so this can never wander into a following nested value's
 * opening delimiter (that was the nested-object skip bug). Unlike the
 * JSON variant below, comma is *not* excluded here -- shell `NAME=value`
 * text has no comma-as-delimiter convention, so excluding it only
 * truncates a value that legitimately contains one (e.g.
 * `TOKEN=abcdefgh,ijklmnop`), leaking the remainder unredacted. Semicolon
 * *is* excluded, unlike comma: this is also what matches a
 * semicolon-delimited connection string (`Server=x;Password=y;Timeout=z`)
 * one `Key=value` segment at a time, so any segment whose key matches
 * SECRET_NAME_PATTERN gets redacted without a bespoke per-key-name
 * pattern (`AccountKey=`, `SharedAccessSignature=`, etc. all go through
 * this same pass, not just `Password=`/`Pwd=`). */
const ENV_UNQUOTED_PATTERN = /((?:export\s+)?\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*)([^\s;}\]{"]+)/g;

/** JSON `"name": "value"` -- quoted, same closing-quote/escape rule as above. */
const JSON_QUOTED_PATTERN =
  /("([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

/** JSON `"name": value` -- unquoted (number/bool), same `{`/`[` exclusion. */
const JSON_UNQUOTED_PATTERN = /("([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*)([^\s,}\]{"]+)/g;

const AWS_KEY_PATTERN = /AKIA[0-9A-Z]{16}/g;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Bare-token format backstops, same confidence bar as AWS_KEY_PATTERN/
 * JWT_PATTERN above: recognizable by shape alone, no NAME= prefix needed.
 * These specifically target the highest-frequency real-world "secret
 * pasted in prose with no key name nearby" shape (e.g. an agent writing
 * "...using key sk_live_51H8x... which is hardcoded in config.py") --
 * the one leak shape none of the NAME=value patterns above can catch,
 * since there's no name to anchor on. A fully general high-entropy-string
 * detector is deliberately out of scope (real false-positive cost, not a
 * cheap addition like these three well-known formats).
 */
const STRIPE_KEY_PATTERN = /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}\b/g;
const GITHUB_TOKEN_PATTERN = /\bgh[oprsu]_[A-Za-z0-9]{16,}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;

/**
 * `scheme://user:password@host` -- catches credentials embedded in a
 * connection string/DSN (e.g. DATABASE_URL, MONGO_URI), which carries a
 * password without the var *name* itself ever matching SECRET_NAME_PATTERN.
 * Redacts only the `user:password@` segment, keeping the rest of the URL
 * (host/port/path) intact since that part isn't secret and is often useful
 * context (e.g. which database).
 */
const URL_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/g;

const MIN_ENV_VALUE_LENGTH = 8;
const MIN_PATTERN_VALUE_LENGTH = 6;

/** Matches a value that's itself a URL (`scheme://...`) -- see
 * makeNameValueRedactor's use of this below for why. */
const URL_SHAPED_VALUE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Builds a replacer for one of the four NAME_VALUE patterns above.
 * `quoted` controls both the true/false/number skip (only meaningful for
 * an unquoted JSON value) and whether the replacement re-wraps in quotes.
 */
function makeNameValueRedactor(quoted: boolean) {
  return (match: string, prefix: string, name: string, value: string): string => {
    if (!SECRET_NAME_PATTERN.test(name)) return match;
    if (!quoted) {
      if (value === "true" || value === "false") return match;
      if (/^-?\d+(\.\d+)?$/.test(value)) return match;
    }
    if (value.length < MIN_PATTERN_VALUE_LENGTH) return match;
    // A URL-shaped value (e.g. DATABASE_URL=postgres://user:pass@host/db)
    // is left to URL_CREDENTIAL_PATTERN below, which redacts only the
    // embedded user:pass@ segment and keeps the rest (host/port/path) --
    // useful context, and often not secret at all if there's no embedded
    // credential. Redacting the whole value here would be both less
    // precise and would run before URL_CREDENTIAL_PATTERN ever gets a
    // chance to see the original value.
    if (URL_SHAPED_VALUE.test(value)) return match;
    return quoted ? `${prefix}"REDACTED_SECRET"` : `${prefix}REDACTED_SECRET`;
  };
}

/**
 * Redacts secret-shaped values (API keys, tokens, passwords, credentials)
 * from any string before it's printed to a terminal or written to a log.
 * Two layers: a known-value pass, and a name/format pattern pass.
 *
 * The known-value pass only ever helps for secrets *this Node process
 * itself* inherited (e.g. `JIRA_API_TOKEN`, read from this process's own
 * `process.env`) -- it catches those if a child process ever echoes one
 * back verbatim. It does *not* help with a target repo's own secrets
 * loaded via `direnv` inside a child Bash session: `direnv` activation
 * happens entirely in that child's own shell and never touches this
 * process's `process.env`, so those values are invisible to this pass.
 * The name/format pattern pass below is the real defense for that case --
 * it catches a `.envrc`/`env`/`printenv` dump or a bare-shaped token
 * regardless of whether the value ever touched this process's own
 * environment. Pure, defensive: never throws (including on non-string
 * input), and a string with nothing to redact is returned unchanged.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string") return "";
  let result = text;

  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
    if (!SECRET_NAME_PATTERN.test(name)) continue;
    result = result.split(value).join("REDACTED_SECRET");
  }

  // Quoted patterns run first: once a value is replaced with
  // "REDACTED_SECRET", the character right after `:`/`=` is a quote,
  // which the unquoted patterns' value class explicitly excludes -- so
  // they can never re-match an already-redacted quoted value.
  result = result.replace(JSON_QUOTED_PATTERN, makeNameValueRedactor(true));
  result = result.replace(ENV_QUOTED_PATTERN, makeNameValueRedactor(true));
  result = result.replace(JSON_UNQUOTED_PATTERN, makeNameValueRedactor(false));
  result = result.replace(ENV_UNQUOTED_PATTERN, makeNameValueRedactor(false));

  result = result.replace(AWS_KEY_PATTERN, "REDACTED_SECRET");
  result = result.replace(JWT_PATTERN, "REDACTED_SECRET");
  result = result.replace(STRIPE_KEY_PATTERN, "REDACTED_SECRET");
  result = result.replace(GITHUB_TOKEN_PATTERN, "REDACTED_SECRET");
  result = result.replace(SLACK_TOKEN_PATTERN, "REDACTED_SECRET");
  result = result.replace(URL_CREDENTIAL_PATTERN, "$1REDACTED_SECRET@");

  return result;
}

/**
 * Boolean check reusing `redactSecrets`'s own patterns -- true if `text`
 * contains anything `redactSecrets` would redact, false otherwise. This is
 * what the `.claude/hooks/block-secret-comments.sh` hook (via
 * `scripts/check-secret-in-tool-input.ts`) uses to decide whether to deny a
 * Jira/Confluence write, so this is intentionally the *same* detection
 * logic as `redactSecrets`, not a second, drifting reimplementation.
 * Pure, defensive: never throws (including on non-string input), and
 * returns false rather than throwing when there's nothing to check.
 */
export function containsSecret(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return redactSecrets(text) !== text;
}

/**
 * The single funnel callers outside this module should use: PII redaction
 * followed by secret redaction, so any text printed to a terminal or
 * written to a log has both passes applied.
 */
export function redactSensitive(text: string): string {
  return redactSecrets(redactPII(text));
}
