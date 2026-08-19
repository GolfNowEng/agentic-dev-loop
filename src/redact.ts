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
