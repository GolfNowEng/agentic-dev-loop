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
 * wildcard -- an earlier draft used one and it matched `issueIdOrKey`, a
 * field present on nearly every Jira API call/response, which would make
 * containsSecret() (see below) deny legitimate calls. `KEY` here is
 * deliberately anchored to compound forms (`SIGNING_KEY`, `ACCOUNT_KEY`,
 * etc.) and a standalone `^KEY$` case, never an unanchored substring.
 *
 * The bare `KEY` alternative is intentionally its own case-sensitive,
 * uppercase-only anchor (`BARE_KEY_PATTERN` below), not folded into the
 * shared `/i` flag the rest of this pattern uses: matching it case-
 * insensitively caught ordinary lowercase JSON `"key"` fields too --
 * e.g. Jira's `parent: {"key": "TARS-1080"}`, which is not a secret.
 * `KEY=...` (the real env-var shape this alternative targets) is
 * conventionally uppercase, so anchoring it to case preserves the
 * original detection while dropping the false positive.
 */
const SECRET_NAME_PATTERN =
  /SECRET|TOKEN|API[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL|ACCESS[_-]?KEY|AUTH|SIGNING[_-]?KEY|ACCOUNT[_-]?KEY|ROLE[_-]?KEY|ENCRYPTION[_-]?KEY|DSN|CONNECTION[_-]?STRING|CONN[_-]?STR|DATABASE[_-]?URL|DB[_-]?URL|URI|COOKIE|SESSION/i;
const BARE_KEY_PATTERN = /^KEY$/;

function isSecretShapedName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name) || BARE_KEY_PATTERN.test(name);
}

/**
 * `NAME=value` / `export NAME=value` -- env-style, so the name is required
 * to look like an env var (snake case, case-insensitive -- a target repo's
 * own .envrc/shell scripts can use lowercase names like `github_token=`) to
 * avoid matching arbitrary prose like "Authorization: Bearer ...".
 *
 * Split into quoted/unquoted variants rather than one pattern with an
 * optional trailing quote: an optional quote is ambiguous about where the
 * value ends, which let it either stop at the first comma inside a quoted
 * JSON-shaped value, or (when unquoted) consume a following nested `{`,
 * permanently desyncing the regex and silently skipping every key after it.
 *
 * The quoted variant is JSON/shell-escape aware (`(?:[^"\\]|\\.)*`) so an
 * escaped `\"` inside the value doesn't terminate it early. The unquoted
 * variant excludes `{`, `[`, and `"` so it can never wander into a
 * following value's opening delimiter -- but, unlike the JSON variants,
 * deliberately does NOT exclude comma, since shell `NAME=value` text has no
 * comma-as-delimiter convention and excluding it would truncate a
 * legitimate value like `TOKEN=abcdefgh,ijklmnop`, leaking the remainder.
 */
const ENV_QUOTED_PATTERN =
  /((?:export\s+)?\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*)"((?:[^"\\]|\\.)*)"/g;
const ENV_UNQUOTED_PATTERN =
  /((?:export\s+)?\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*)([^\s;"{}[\]]+)/g;

/**
 * JSON `"name": "value"` -- the quoted key is what makes this unambiguous.
 * Same quoted/unquoted split and reasoning as the env-style patterns above,
 * except here comma IS excluded from the unquoted value class since comma
 * is a real syntactic delimiter in JSON.
 */
const JSON_QUOTED_PATTERN =
  /("([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
const JSON_UNQUOTED_PATTERN =
  /("([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*)([^\s",{}[\]]+)/g;

/**
 * Research-loop's unquoted value classes (research 334ced5), written
 * independently of dev's above. They differ only in NOT excluding `[`, so
 * they redact a secret value that starts with `[` (`TOKEN=[abc...]`) which
 * dev's classes leak; dev's classes plus dev's pass order in turn redact
 * shapes research's leak (e.g. an env-style assignment in JSON-value
 * position, redacted past its comma). Neither set contains the other
 * (found by differential fuzzing during the 2.0.0 core unification), so
 * redactSecrets() runs both passes: every secret either side redacted is
 * still redacted. See docs/migration-ledger.md (redact).
 */
const ENV_UNQUOTED_BRACKET_PATTERN =
  /((?:export\s+)?\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*)([^\s;}\]{"]+)/g;
const JSON_UNQUOTED_BRACKET_PATTERN =
  /("([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*)([^\s,}\]{"]+)/g;

const AWS_KEY_PATTERN = /AKIA[0-9A-Z]{16}/g;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

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

/**
 * Credentials embedded in a connection string/DSN (e.g.
 * `postgres://user:pass@host`) -- a final pattern pass to redact only the
 * embedded `user:pass` part. Note: as of Task 1, `DATABASE_URL` and `URI`
 * now match SECRET_NAME_PATTERN, so the generic name/value pass attempts to
 * redact the entire URL value (a temporary known regression until Task 4
 * adds a URL_SHAPED_VALUE guard). This pattern runs after and catches the
 * embedded credentials directly, providing defense-in-depth. Applied
 * unconditionally, like the AWS-key and JWT backstops above.
 */
const CONNECTION_STRING_CREDENTIALS_PATTERN =
  /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/g;

const MIN_ENV_VALUE_LENGTH = 8;
const MIN_PATTERN_VALUE_LENGTH = 6;

/** Matches a value that's itself a URL (`scheme://...`) -- see the skip
 * check in redactQuoted/redactUnquoted below for why. */
const URL_SHAPED_VALUE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Redacts secret-shaped values (API keys, tokens, passwords, credentials)
 * from any string before it's printed to a terminal or written to a log.
 * Two layers: known values currently held in this process's own env (so an
 * inherited secret echoed back by a child process is caught even with no
 * matching name in the text), and a name/value pattern pass for secrets
 * that never touched this process's own env (e.g. a target repo's own
 * `.envrc`/`.env` dumped by a child Bash call). Pure, defensive: never
 * throws, and a string with nothing to redact is returned unchanged.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string") return "";
  let result = text;

  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
    if (!isSecretShapedName(name)) continue;
    result = result.split(value).join("REDACTED_SECRET");
  }

  const isRedactableValue = (value: string): boolean => {
    if (value === "true" || value === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return false;
    if (value.length < MIN_PATTERN_VALUE_LENGTH) return false;
    return true;
  };

  const redactQuoted = (
    match: string,
    prefix: string,
    name: string,
    value: string,
  ): string => {
    if (!isSecretShapedName(name)) return match;
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
    if (!isSecretShapedName(name)) return match;
    if (!isRedactableValue(value)) return match;
    if (URL_SHAPED_VALUE.test(value)) return match;
    return `${prefix}REDACTED_SECRET`;
  };

  // Quoted variants run first so an already-redacted "REDACTED_SECRET"
  // can't be re-matched by an unquoted pattern (which excludes `"`).
  // Pass 1: dev-loop's order and value classes.
  result = result.replace(ENV_QUOTED_PATTERN, redactQuoted);
  result = result.replace(JSON_QUOTED_PATTERN, redactQuoted);
  result = result.replace(ENV_UNQUOTED_PATTERN, redactUnquoted);
  result = result.replace(JSON_UNQUOTED_PATTERN, redactUnquoted);
  // Pass 2: research-loop's order and value classes, over pass 1's output.
  // An already-redacted value re-redacts to itself, so this only ever adds
  // redactions; together the two passes redact the union of both sides.
  result = result.replace(JSON_QUOTED_PATTERN, redactQuoted);
  result = result.replace(ENV_QUOTED_PATTERN, redactQuoted);
  result = result.replace(JSON_UNQUOTED_BRACKET_PATTERN, redactUnquoted);
  result = result.replace(ENV_UNQUOTED_BRACKET_PATTERN, redactUnquoted);

  result = result.replace(AWS_KEY_PATTERN, "REDACTED_SECRET");
  result = result.replace(JWT_PATTERN, "REDACTED_SECRET");
  result = result.replace(STRIPE_KEY_PATTERN, "REDACTED_SECRET");
  result = result.replace(GITHUB_TOKEN_PATTERN, "REDACTED_SECRET");
  result = result.replace(SLACK_TOKEN_PATTERN, "REDACTED_SECRET");
  result = result.replace(
    CONNECTION_STRING_CREDENTIALS_PATTERN,
    "$1REDACTED_SECRET@",
  );

  return result;
}

/**
 * Boolean check reusing redactSecrets's own patterns -- true if `text`
 * contains anything redactSecrets would redact, false otherwise. This is
 * what the .claude/hooks/block-secret-comments.sh hook (via
 * scripts/check-secret-in-tool-input.ts) uses to decide whether to deny a
 * `gh pr create`/`gh pr edit` Bash call (dev) or a Jira/Confluence write
 * (research), so this is intentionally the
 * *same* detection logic as redactSecrets, not a second, drifting
 * reimplementation. Pure, defensive: never throws, and returns false
 * rather than throwing when there's nothing to check.
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
