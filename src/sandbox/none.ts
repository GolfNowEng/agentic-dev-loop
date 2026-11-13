import type { SandboxAdapter } from "./types.ts";

/** The default: no sandbox. Every method is a no-op and the spawn is untouched. */
export const noneAdapter: SandboxAdapter = {
  name: "none",
  validateConfig: (raw) => raw,
  preflight: async () => {},
  cleanupOrphans: async (_scope) => {},
  prepare: async (run) => ({ adapter: "none", instanceName: run.instanceName }),
  wrap: (_h, cmd, args, opts) => ({ cmd, args, opts }),
  inspect: async () => ({ denied: [] }),
  teardown: async () => {},
};
