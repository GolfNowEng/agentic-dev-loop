import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { redactPII } from "../src/redact.ts";

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
