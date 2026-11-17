// Sandbox reset steps: whatever the project's sandbox adapters bring.
import { sandboxInstancePrefix, sandboxNamePart } from "../../worker/skill-runner.ts";
import { ADAPTERS } from "../../sandbox/index.ts";
import type { SandboxAdapter } from "../../sandbox/types.ts";
import type { Config } from "../types.ts";
import type { ResetCtx } from "./context.ts";
import type { ResetStep, Survey } from "./step.ts";

export function sandboxSteps(ctx: ResetCtx): ResetStep[] {
  // ctx.slug is what main.ts passes to sandboxInstancePrefix/sandboxInstanceName.
  return ctx.sandbox?.resetSteps?.({ prefix: sandboxInstancePrefix(ctx.slug), ticket: sandboxNamePart(ctx.ticket) }, ctx.sandboxConfig) ?? [];
}

const validNames = (registry: Readonly<Record<string, SandboxAdapter>>): string => Object.keys(registry).join(", ");

/**
 * Every adapter a run on this project could have used: the one config
 * selects (`sandbox.adapter`), every one with its own sub-block in
 * `config.sandbox` (an opt-in `--sandbox=<name>` loop run has a block but no
 * adapter line), and `cliName` (reset's own --sandbox). Each surveys with its
 * own sub-block. An invalid sub-block becomes a needs-you row; an unknown
 * `cliName` throws, naming the valid adapters.
 */
export function resetSandboxSteps(
  ctx: ResetCtx,
  config: Config | null,
  cliName: string | undefined,
  registry: Readonly<Record<string, SandboxAdapter>> = ADAPTERS,
): ResetStep[] {
  if (cliName !== undefined && !Object.hasOwn(registry, cliName)) {
    throw new Error(`--sandbox: unknown sandbox adapter "${cliName}"; valid: ${validNames(registry)}`);
  }
  const block = (config?.sandbox ?? {}) as Record<string, unknown>;
  const names = new Set<string>();
  const selected = block.adapter;
  if (typeof selected === "string") names.add(selected);
  for (const n of Object.keys(registry)) if (block[n] !== undefined) names.add(n);
  if (cliName !== undefined) names.add(cliName);

  const steps: ResetStep[] = [];
  for (const name of names) {
    const adapter = Object.hasOwn(registry, name) ? registry[name] : undefined;
    if (!adapter) {
      // config.ts rejects this at load; kept as a row rather than a crash.
      steps.push(blocked(`unknown sandbox adapter "${name}"; valid: ${validNames(registry)}`));
      continue;
    }
    if (!adapter.resetSteps) continue;
    let adapterConfig: unknown;
    try {
      adapterConfig = adapter.validateConfig(block[name]);
    } catch (e) {
      steps.push(blocked(`sandbox.${name}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`));
      continue;
    }
    steps.push(...sandboxSteps({ ...ctx, sandbox: adapter, sandboxConfig: adapterConfig }));
  }
  return steps;
}

const blocked = (why: string): ResetStep => ({
  area: "sandbox",
  name: "leftover sandboxes",
  survey: async (): Promise<Survey> => ({ found: "-", action: null, needsYou: why }),
});
