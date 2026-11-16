// The three model-alias env names, filled from the user's Claude Code
// settings (~/.claude/settings.json "env") when the loop's own env lacks
// them, so settings.json stays the one source of truth. Only these names
// are ever copied: the file can also hold tokens, and nothing else is read
// from it. Inside a sandbox the file is not visible, so this host-side
// fill is how the values get in (passed by name via the adapter).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODEL_ENV_NAMES = ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"] as const;

export const defaultClaudeSettingsPath = (): string => join(homedir(), ".claude", "settings.json");

/** Sets each unset model name in `env` from the settings file; returns the names it filled. Never throws. */
export function fillModelEnvFromClaudeSettings(env: NodeJS.ProcessEnv, settingsPath: string = defaultClaudeSettingsPath()): string[] {
  let fromFile: unknown;
  try {
    fromFile = (JSON.parse(readFileSync(settingsPath, "utf8")) as { env?: unknown } | null)?.env;
  } catch {
    return [];
  }
  if (typeof fromFile !== "object" || fromFile === null || Array.isArray(fromFile)) return [];
  const filled: string[] = [];
  for (const name of MODEL_ENV_NAMES) {
    if (env[name]) continue;
    const v = (fromFile as Record<string, unknown>)[name];
    if (typeof v === "string" && v !== "") {
      env[name] = v;
      filled.push(name);
    }
  }
  return filled;
}
