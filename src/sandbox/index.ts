import { noneAdapter } from "./none.ts";
import type { SandboxAdapter } from "./types.ts";

/** The registry. One line per adapter. */
export const ADAPTERS: Readonly<Record<string, SandboxAdapter>> = {
  none: noneAdapter,
};

export const DEFAULT_ADAPTER = "none";

export function adapterNames(): string[] {
  return Object.keys(ADAPTERS);
}

export function getAdapter(name: string): SandboxAdapter {
  const a = Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined;
  if (!a) throw new Error(`unknown sandbox adapter "${name}"; valid: ${adapterNames().join(", ")}`);
  return a;
}
