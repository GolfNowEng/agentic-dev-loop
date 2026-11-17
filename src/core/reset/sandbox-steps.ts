// Sandbox reset steps: whatever the project's sandbox adapter brings.
import { sandboxInstancePrefix, sandboxNamePart } from "../../worker/skill-runner.ts";
import type { ResetCtx } from "./context.ts";
import type { ResetStep } from "./step.ts";

export function sandboxSteps(ctx: ResetCtx): ResetStep[] {
  // ctx.slug is what main.ts passes to sandboxInstancePrefix/sandboxInstanceName.
  return ctx.sandbox?.resetSteps?.({ prefix: sandboxInstancePrefix(ctx.slug), ticket: sandboxNamePart(ctx.ticket) }, ctx.sandboxConfig) ?? [];
}
