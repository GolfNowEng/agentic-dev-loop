// Config sub-block for the sbx sandbox adapter.

export interface SbxConfig {
  kitDir: string;
  memory?: string;
  envAllow: string[];
}

export const DEFAULT_ENV_ALLOW = [
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS",
];

const KNOWN = new Set(["kitDir", "memory", "envAllow"]);
const SECRET_SHAPED = /TOKEN|SECRET|KEY|PASSWORD|AUTH/i;
const MEMORY = /^[1-9][0-9]*[kmg]b?$/i;

export function validateSbxConfig(raw: unknown): SbxConfig {
  if (raw === undefined || raw === null) throw new Error("sandbox.sbx: kitDir is required");
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("sandbox.sbx: config must be an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KNOWN.has(k)) throw new Error(`sandbox.sbx: unknown key "${k}"`);
  if (o.kitDir === undefined) throw new Error("sandbox.sbx: kitDir is required");
  if (typeof o.kitDir !== "string" || o.kitDir === "") throw new Error("sandbox.sbx: kitDir must be a non-empty string");
  if (!o.kitDir.startsWith("/")) throw new Error("sandbox.sbx: kitDir must be an absolute path");
  const cfg: SbxConfig = { kitDir: o.kitDir, envAllow: [] };
  if (o.memory !== undefined) {
    if (typeof o.memory !== "string" || !MEMORY.test(o.memory)) throw new Error('sandbox.sbx: memory must look like "4g" or "512m"');
    cfg.memory = o.memory;
  }
  let extra: unknown[] = [];
  if (o.envAllow !== undefined) {
    if (!Array.isArray(o.envAllow) || o.envAllow.some((n) => typeof n !== "string" || n === "")) {
      throw new Error("sandbox.sbx: envAllow must be an array of env var names");
    }
    extra = o.envAllow;
  }
  for (const n of extra as string[]) {
    if (SECRET_SHAPED.test(n)) throw new Error(`sandbox.sbx: envAllow may not pass "${n}" (secret-shaped)`);
  }
  cfg.envAllow = [...new Set([...DEFAULT_ENV_ALLOW, ...(extra as string[])])];
  return cfg;
}
