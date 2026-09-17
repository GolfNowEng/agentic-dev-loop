import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { redactPII, redactSecrets, redactSensitive, containsSecret } from "../src/redact.ts";

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

  it("redacts a JSON secret value containing a comma without corrupting JSON", () => {
    const input = '{"apiKey":"secret,value123"}';
    const output = redactSecrets(input);
    expect(output).toBe('{"apiKey":"REDACTED_SECRET"}');
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("redacts a secret nested inside a JSON object, not just top-level keys", () => {
    expect(
      redactSecrets('{"nested":{"clientSecret":"zzz999anothersecretvalue"}}'),
    ).toBe('{"nested":{"clientSecret":"REDACTED_SECRET"}}');
  });

  it("still redacts a sibling key after a nested object value", () => {
    expect(
      redactSecrets('{"outer":{"a":"b"},"apiKey":"abc123secretvalue"}'),
    ).toBe('{"outer":{"a":"b"},"apiKey":"REDACTED_SECRET"}');
  });

  it("redacts an env-style secret value containing a comma, in full", () => {
    expect(redactSecrets("export TOKEN=abcdefgh,ijklmnop")).toBe(
      "export TOKEN=REDACTED_SECRET",
    );
  });

  it("redacts a quoted env-style secret value containing a comma", () => {
    expect(redactSecrets('export TOKEN="abcdefgh,ijklmnop"')).toBe(
      'export TOKEN="REDACTED_SECRET"',
    );
  });

  it("redacts a JSON secret value containing an escaped quote", () => {
    const input = String.raw`{"token":"abc\"def123456"}`;
    const output = redactSecrets(input);
    expect(output).toBe('{"token":"REDACTED_SECRET"}');
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("does not truncate a non-secret comma-separated value", () => {
    expect(redactSecrets("PORT=5001,3000")).toBe("PORT=5001,3000");
  });

  it("redacts multiple secret-shaped vars on one line independently", () => {
    expect(
      redactSecrets("API_KEY=abc123secretvalue NEXT_TOKEN=def456anothersecretvalue"),
    ).toBe("API_KEY=REDACTED_SECRET NEXT_TOKEN=REDACTED_SECRET");
  });

  it("redacts a lowercase env-style secret var name", () => {
    expect(redactSecrets("github_token=ghp_abcdefghijklmnop")).toBe(
      "github_token=REDACTED_SECRET",
    );
  });

  it("redacts a mixed-case JSON secret key name", () => {
    expect(redactSecrets('{"clientSecret":"zzz999anothersecretvalue"}')).toBe(
      '{"clientSecret":"REDACTED_SECRET"}',
    );
  });

  it("redacts embedded user:password credentials in a connection string, keeping the host", () => {
    expect(
      redactSecrets("DATABASE_URL=postgres://user:hunter2pass@localhost:5432/db"),
    ).toBe("DATABASE_URL=postgres://REDACTED_SECRET@localhost:5432/db");
  });

  it("redacts embedded credentials in a bare URL with no matching var name", () => {
    expect(redactSecrets("connecting to postgres://admin:s3cr3tpass@db.internal/app")).toBe(
      "connecting to postgres://REDACTED_SECRET@db.internal/app",
    );
  });

  it("does not touch a URL with no embedded credentials", () => {
    expect(redactSecrets("DATABASE_URL=postgres://localhost:5432/db")).toBe(
      "DATABASE_URL=postgres://localhost:5432/db",
    );
  });

  it("never throws on empty input", () => {
    expect(() => redactSecrets("")).not.toThrow();
    expect(redactSecrets("")).toBe("");
  });

  it("redacts a SIGNING_KEY-named value", () => {
    expect(redactSecrets("SIGNING_KEY=abcdefghijklmnop")).toBe(
      "SIGNING_KEY=REDACTED_SECRET",
    );
  });

  it("redacts a bare KEY-named value", () => {
    expect(redactSecrets("KEY=abcdefghijklmnop")).toBe("KEY=REDACTED_SECRET");
  });

  it("does not redact a lowercase 'key' JSON field (e.g. Jira's parent.key)", () => {
    // Regression: an earlier version of SECRET_NAME_PATTERN's bare KEY
    // anchor ran case-insensitively, so it matched ordinary lowercase
    // "key" fields too -- e.g. Jira's `parent: {"key": "TARS-1080"}`,
    // which every Epic-linked issue create sends and which is not a
    // secret. containsSecret() backs the PreToolUse hook that denies
    // Jira/Confluence writes, so this false positive blocked issue
    // creation on any project requiring an Epic parent.
    const json = '{"parent":{"key":"TARS-1080"}}';
    expect(redactSecrets(json)).toBe(json);
    expect(containsSecret(json)).toBe(false);
  });

  it("redacts a SUPABASE_SERVICE_ROLE_KEY-named value", () => {
    expect(redactSecrets("SUPABASE_SERVICE_ROLE_KEY=abcdefghijklmnop")).toBe(
      "SUPABASE_SERVICE_ROLE_KEY=REDACTED_SECRET",
    );
  });

  it("redacts a semicolon-delimited connection-string password segment", () => {
    expect(redactSecrets("Server=myhost;Password=abcdefghijklmnop;Timeout=30")).toBe(
      "Server=myhost;Password=REDACTED_SECRET;Timeout=30",
    );
  });

  it("redacts a semicolon-delimited connection-string AccountKey segment", () => {
    expect(
      redactSecrets("DefaultEndpointsProtocol=https;AccountKey=abcdefghijklmnop;EndpointSuffix=core.windows.net"),
    ).toBe(
      "DefaultEndpointsProtocol=https;AccountKey=REDACTED_SECRET;EndpointSuffix=core.windows.net",
    );
  });

  it("does not touch a non-secret semicolon-delimited segment", () => {
    expect(redactSecrets("Server=myhost;Timeout=30")).toBe("Server=myhost;Timeout=30");
  });

  it("redacts a bare Stripe-shaped secret key with no matching var name", () => {
    expect(
      redactSecrets("using key sk_live_51H8xabcdefghijklmnopqrstuvwxyz which is hardcoded"),
    ).toBe("using key REDACTED_SECRET which is hardcoded");
  });

  it("redacts a bare GitHub-shaped token with no matching var name", () => {
    expect(redactSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(
      "token: REDACTED_SECRET",
    );
  });

  it("redacts a bare Slack-shaped token with no matching var name", () => {
    expect(redactSecrets("webhook uses xoxb-1234567890-abcdefghijklmnop")).toBe(
      "webhook uses REDACTED_SECRET",
    );
  });

  it("never throws on non-string input", () => {
    // @ts-expect-error -- deliberately testing runtime defensiveness against bad input
    expect(() => redactSecrets(null)).not.toThrow();
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
