import type { Config } from "../core/types.ts";
import { DEFAULT_ADAPTER, getAdapter } from "./index.ts";
import type { SandboxAdapter, SandboxMode } from "./types.ts";

export interface SandboxSelection {
  adapter: SandboxAdapter;
  mode: SandboxMode;
  /** The selected adapter's validated own sub-block (undefined when absent). */
  config: unknown;
}

/** cliName wins over config.sandbox.adapter; neither gives the none adapter. mode defaults to "enforce". */
export function selectSandbox(config: Config, cliName: string | undefined): SandboxSelection {
  const block = config.sandbox;
  const name = cliName ?? block?.adapter ?? DEFAULT_ADAPTER;
  let adapter: SandboxAdapter;
  try {
    adapter = getAdapter(name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(cliName !== undefined ? `--sandbox: ${msg}` : `sandbox.adapter: ${msg}`);
  }
  return { adapter, mode: block?.mode ?? "enforce", config: adapter.validateConfig(block?.[adapter.name]) };
}
