// Config sub-block for the sbx sandbox adapter.

export interface SbxConfig {
  kitDir: string;
  memory?: string;
  /** A saved `sbx template save` image; created with `-t <ref> --pull never`. */
  template?: string;
  envAllow: string[];
}

export const DEFAULT_ENV_ALLOW = [
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS",
];

const KNOWN = new Set(["kitDir", "memory", "template", "envAllow"]);
/** An OCI-style image reference: no spaces or shell characters, never a flag. */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;
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
  if (o.template !== undefined) {
    if (typeof o.template !== "string" || !IMAGE_REF.test(o.template)) {
      throw new Error('sandbox.sbx: template must be an image reference like "docker.io/library/dev-loop-sbx:v1"');
    }
    cfg.template = o.template;
  }
  let extra: unknown[] = [];
  if (o.envAllow !== undefined) {
    if (!Array.isArray(o.envAllow) || o.envAllow.some((n) => typeof n !== "string")) {
      throw new Error("sandbox.sbx: envAllow must be an array of env var names");
    }
    extra = o.envAllow;
  }
  for (const n of extra as string[]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`sandbox.sbx: envAllow entry "${n}" must be a bare env var name`);
    if (SECRET_SHAPED.test(n)) throw new Error(`sandbox.sbx: envAllow may not pass "${n}" (secret-shaped)`);
  }
  cfg.envAllow = [...new Set([...DEFAULT_ENV_ALLOW, ...(extra as string[])])];
  return cfg;
}
