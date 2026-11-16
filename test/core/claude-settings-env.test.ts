import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { MODEL_ENV_NAMES, fillModelEnvFromClaudeSettings } from "../../src/core/claude-settings-env.ts";

const tmp = mkdtempSync(join(tmpdir(), "claude-settings-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const file = (name: string, body: string): string => {
  const p = join(tmp, name);
  writeFileSync(p, body);
  return p;
};
const SETTINGS = JSON.stringify({
  env: {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "h-id",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "s-id",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "o-id",
    ANTHROPIC_AUTH_TOKEN: "do-not-copy",
    OTHER: "x",
  },
  permissions: { allow: [] },
});

describe("fillModelEnvFromClaudeSettings", () => {
  it("names exactly the three model aliases", () => {
    expect(MODEL_ENV_NAMES).toEqual(["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"]);
  });

  it("fills unset model names from settings.json env, and nothing else", () => {
    const env: NodeJS.ProcessEnv = {};
    const filled = fillModelEnvFromClaudeSettings(env, file("a.json", SETTINGS));
    expect(env).toEqual({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "h-id", ANTHROPIC_DEFAULT_SONNET_MODEL: "s-id", ANTHROPIC_DEFAULT_OPUS_MODEL: "o-id" });
    expect(filled).toEqual([...MODEL_ENV_NAMES]);
  });

  it("never overrides a name already set in the env", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_DEFAULT_SONNET_MODEL: "from-shell" };
    const filled = fillModelEnvFromClaudeSettings(env, file("b.json", SETTINGS));
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("from-shell");
    expect(filled).toEqual(["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"]);
  });

  it("treats an empty env value as unset", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_DEFAULT_OPUS_MODEL: "" };
    fillModelEnvFromClaudeSettings(env, file("c.json", SETTINGS));
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("o-id");
  });

  it("skips non-string or empty values in settings", () => {
    const env: NodeJS.ProcessEnv = {};
    const p = file("d.json", JSON.stringify({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 3, ANTHROPIC_DEFAULT_SONNET_MODEL: "" } }));
    expect(fillModelEnvFromClaudeSettings(env, p)).toEqual([]);
    expect(env).toEqual({});
  });

  it("a missing, unparseable or env-less file fills nothing and does not throw", () => {
    for (const p of [join(tmp, "missing.json"), file("e.json", "{not json"), file("f.json", "[]"), file("g.json", '{"env":[1]}')]) {
      const env: NodeJS.ProcessEnv = {};
      expect(fillModelEnvFromClaudeSettings(env, p)).toEqual([]);
      expect(env).toEqual({});
    }
  });
});
