import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { redactPII, redactSecrets, redactSensitive, containsSecret } from "../../src/core/redact.ts";

describe("redactPII", () => {
  it("redacts a bare email address", () => {
    expect(redactPII("contact bob@example.com for help")).toBe(
      "contact REDACTED_EMAIL for help",
    );
  });

  it("redacts an email embedded inside a path", () => {
    expect(redactPII("/Users/bob@example.com/Desktop/repo")).toBe(
      "/Users/REDACTED_EMAIL/Desktop/repo",
    );
  });

  it("redacts the literal os.homedir() value to ~", () => {
    const home = homedir();
    // Only meaningful when homedir() itself isn't email-shaped -- on this
    // machine it is, so the email pass already catches it; this asserts
    // the homedir-specific pass still runs and doesn't double-replace.
    const input = `${home}/Desktop/repo/src/main.ts`;
    const result = redactPII(input);
    expect(result).not.toContain(home);
  });

  it("redacts multiple occurrences in one string", () => {
    expect(redactPII("a@b.com and c@d.com")).toBe(
      "REDACTED_EMAIL and REDACTED_EMAIL",
    );
  });

  it("returns a string with neither an email nor the home dir unchanged", () => {
    expect(redactPII("src/client/App.jsx has no PII")).toBe(
      "src/client/App.jsx has no PII",
    );
  });

  it("redacts an email embedded in JSON-quoted content", () => {
    expect(redactPII('{"email":"x@y.com"}')).toBe('{"email":"REDACTED_EMAIL"}');
  });

  it("never throws on empty input", () => {
    expect(() => redactPII("")).not.toThrow();
    expect(redactPII("")).toBe("");
  });
});

describe("redactSecrets", () => {
  const SECRET_VAR = "SOME_API_TOKEN";
  const SECRET_VALUE = "abc123superlongfakevalue";

  beforeEach(() => {
    process.env[SECRET_VAR] = SECRET_VALUE;
  });

  afterEach(() => {
    delete process.env[SECRET_VAR];
  });

  it("redacts a literal occurrence of a secret-shaped env var's current value", () => {
    expect(redactSecrets(`token is ${SECRET_VALUE} in the log`)).toBe(
      "token is REDACTED_SECRET in the log",
    );
  });

  it("redacts an export line for a secret-shaped var, keeping the key name", () => {
    expect(redactSecrets(`export ${SECRET_VAR}=${SECRET_VALUE}`)).toBe(
      `export ${SECRET_VAR}=REDACTED_SECRET`,
    );
  });

  it("redacts a bare NAME=value line for a secret-shaped var not in process.env", () => {
    expect(redactSecrets("CLIENT_SECRET=zzz999anothersecretvalue")).toBe(
      "CLIENT_SECRET=REDACTED_SECRET",
    );
  });

  it("redacts a JSON-quoted secret value, keeping the key name", () => {
    expect(redactSecrets('{"clientSecret":"zzz999anothersecretvalue"}')).toBe(
      '{"clientSecret":"REDACTED_SECRET"}',
    );
  });

  it("does not touch a boolean value for a secret-shaped key", () => {
    expect(redactSecrets('{"hasClientSecret":true}')).toBe(
      '{"hasClientSecret":true}',
    );
  });

  it("does not touch a numeric value for a secret-shaped key", () => {
    expect(redactSecrets('{"clientSecretLength":16}')).toBe(
      '{"clientSecretLength":16}',
    );
  });

  it("does not touch a non-secret-shaped var", () => {
    expect(redactSecrets("PORT=5001")).toBe("PORT=5001");
    expect(redactSecrets("NODE_ENV=development")).toBe("NODE_ENV=development");
  });

  it("redacts an AWS-shaped access key with no matching var name", () => {
    expect(redactSecrets("key: AKIAABCDEFGHIJKLMNOP")).toBe(
      "key: REDACTED_SECRET",
    );
  });

  it("redacts a JWT with no matching var name", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe(
      "Authorization: Bearer REDACTED_SECRET",
    );
  });

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

  it("never throws on empty input", () => {
    expect(() => redactSecrets("")).not.toThrow();
    expect(redactSecrets("")).toBe("");
  });

  it("never throws on non-string input", () => {
    // @ts-expect-error -- deliberately testing runtime defensiveness against bad input
    expect(() => redactSecrets(null)).not.toThrow();
  });

  it("redacts a JSON value containing a comma without corrupting the JSON", () => {
    const result = redactSecrets('{"apiKey":"secret,value"}');
    expect(() => JSON.parse(result)).not.toThrow();
    expect(result).toBe('{"apiKey":"REDACTED_SECRET"}');
  });

  it("redacts a secret nested inside a JSON object, and still redacts a sibling key after it", () => {
    const result = redactSecrets(
      '{"nested":{"clientSecret":"zzz999anothersecretvalue"},"apiKey":"anotherlongsecretvalue"}',
    );
    expect(result).toBe(
      '{"nested":{"clientSecret":"REDACTED_SECRET"},"apiKey":"REDACTED_SECRET"}',
    );
  });

  it("redacts the full value of a comma-containing env-style secret, not just up to the comma", () => {
    expect(redactSecrets("TOKEN=abcdefgh,ijklmnop")).toBe("TOKEN=REDACTED_SECRET");
  });

  it("does not touch a non-secret comma-separated env value", () => {
    expect(redactSecrets("PORT=5001,3000")).toBe("PORT=5001,3000");
  });

  it("redacts a JSON secret value containing an escaped quote", () => {
    const result = redactSecrets('{"apiKey":"sec\\"retvalue123"}');
    expect(() => JSON.parse(result)).not.toThrow();
    expect(result).toBe('{"apiKey":"REDACTED_SECRET"}');
  });

  it("redacts a lowercase-named secret-shaped env var", () => {
    expect(redactSecrets("github_token=zzz999anothersecretvalue")).toBe(
      "github_token=REDACTED_SECRET",
    );
  });

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

  it("does not redact a lowercase 'key' JSON field (e.g. Jira's parent.key)", () => {
    // Regression: an earlier version of SECRET_NAME_PATTERN's bare KEY
    // anchor ran case-insensitively, so it matched ordinary lowercase
    // "key" fields too -- e.g. Jira's `parent: {"key": "TARS-1080"}`,
    // which every Epic-linked issue create sends and which is not a
    // secret. containsSecret() backs the PreToolUse hook that denies
    // writes, so this false positive could block a Jira-shaped payload
    // that ever reaches this check.
    const json = '{"parent":{"key":"TARS-1080"}}';
    expect(redactSecrets(json)).toBe(json);
    expect(containsSecret(json)).toBe(false);
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

  // Cases from research-loop/test/redact.test.ts not already covered above.
  it("redacts an export-prefixed env-style secret value containing a comma, in full", () => {
    expect(redactSecrets("export TOKEN=abcdefgh,ijklmnop")).toBe(
      "export TOKEN=REDACTED_SECRET",
    );
  });

  it("redacts a quoted env-style secret value containing a comma", () => {
    expect(redactSecrets('export TOKEN="abcdefgh,ijklmnop"')).toBe(
      'export TOKEN="REDACTED_SECRET"',
    );
  });

  it("redacts multiple secret-shaped vars on one line independently", () => {
    expect(
      redactSecrets("API_KEY=abc123secretvalue NEXT_TOKEN=def456anothersecretvalue"),
    ).toBe("API_KEY=REDACTED_SECRET NEXT_TOKEN=REDACTED_SECRET");
  });

  it("redacts a mixed-case JSON secret key name", () => {
    expect(redactSecrets('{"clientSecret":"zzz999anothersecretvalue"}')).toBe(
      '{"clientSecret":"REDACTED_SECRET"}',
    );
  });

  it("redacts embedded credentials in a bare URL with no matching var name", () => {
    expect(redactSecrets("connecting to postgres://admin:s3cr3tpass@db.internal/app")).toBe(
      "connecting to postgres://REDACTED_SECRET@db.internal/app",
    );
  });

  it("does not touch a URL with no embedded credentials under a secret-shaped name", () => {
    expect(redactSecrets("DATABASE_URL=postgres://localhost:5432/db")).toBe(
      "DATABASE_URL=postgres://localhost:5432/db",
    );
  });
});

// dev's and research's redactSecrets() were written independently (dev
// 17dc2b7, research 334ced5) and differential fuzzing showed each redacts
// shapes the other leaks. The unified core redacts the union.
describe("redactSecrets -- union of dev and research pattern sets", () => {
  // research-only: research skips true/false/numeric values only when
  // UNQUOTED; a quoted all-digit or boolean string under a secret name is
  // still a secret (e.g. a numeric PIN/password).
  it("redacts a quoted all-digit JSON secret value (research)", () => {
    expect(redactSecrets('{"password":"123456789012"}')).toBe('{"password":"REDACTED_SECRET"}');
  });

  it("redacts a quoted all-digit env-style secret value (research)", () => {
    expect(redactSecrets('PASSWORD="123456789012"')).toBe('PASSWORD="REDACTED_SECRET"');
  });

  // Not a divergence: "true"/"false" (4-5 chars) are under
  // MIN_PATTERN_VALUE_LENGTH (6), so research leaves them too. Pinned so the
  // boolean-skip change below cannot start redacting them by accident.
  it("leaves a quoted \"true\" under a secret name alone (below the min length, same as research)", () => {
    expect(redactSecrets('{"password":"true"}')).toBe('{"password":"true"}');
    expect(redactSecrets('PASSWORD="true"')).toBe('PASSWORD="true"');
  });

  it("still leaves an unquoted boolean/number under a secret name alone", () => {
    expect(redactSecrets('{"tokenCount":123456789012,"authEnabled":true}')).toBe(
      '{"tokenCount":123456789012,"authEnabled":true}',
    );
  });

  // research-only: its unquoted value class does not exclude `[`.
  it("redacts an env-style secret value that starts with `[` (research)", () => {
    expect(redactSecrets("TOKEN=[abcdefgh12345]")).toBe("TOKEN=REDACTED_SECRET]");
  });

  it("redacts an unquoted JSON secret value that starts with `[` (research)", () => {
    expect(redactSecrets('{"token": [abcdefgh12345]}')).toBe('{"token": REDACTED_SECRET]}');
  });

  // dev-only: dev runs the env-style pass before the JSON pass, so an
  // env-style assignment sitting in JSON-value position is redacted whole
  // (comma included) instead of being cut at the comma.
  it("redacts an env-style value in JSON-value position in full, past a comma (dev)", () => {
    expect(redactSecrets('"password": SECRET=abcdefgh,ijklmnop')).toBe(
      '"password": REDACTED_SECRET',
    );
  });

  // dev-only: research's order leaves S3cretValZZ here; dev's redacts it.
  it("redacts a later secret after a `[`-led value (dev)", () => {
    const out = redactSecrets("x[PASSWORD=TOKEN[apiKey= S3cretValZZ 123x");
    expect(out).not.toContain("S3cretValZZ");
  });
});

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

describe("redactSensitive", () => {
  it("redacts both PII and secrets in one pass", () => {
    expect(
      redactSensitive('contact bob@example.com; {"apiKey":"zzz999anothersecretvalue"}'),
    ).toBe('contact REDACTED_EMAIL; {"apiKey":"REDACTED_SECRET"}');
  });

  it("never throws on empty input", () => {
    expect(() => redactSensitive("")).not.toThrow();
    expect(redactSensitive("")).toBe("");
  });
});
