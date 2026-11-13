/**
 * Sandbox adapter interface.
 *
 * A wall socket and plugs: the loop is the socket, and it talks only to this
 * interface. Each sandbox (a Docker sandbox plug, an Apple container plug, a
 * cloud sandbox plug) is one adapter file that fits the socket. The `none`
 * adapter is the default "no plug" case: the house works exactly as it does
 * today. Adding a sandbox = one adapter folder + one registry line in
 * index.ts. Removing an adapter = delete its folder + its registry line.
 */
import type { SpawnOptions } from "node:child_process";

export type SandboxMode = "discover" | "enforce";

/** The optional `sandbox` block of a project config. Adapter sub-blocks are keyed by adapter name. */
export interface SandboxConfig {
  /** Absent means the default adapter. */
  adapter?: string;
  mode?: SandboxMode;
  [adapterName: string]: unknown;
}

export interface PreflightCtx {
  repoRoot: string;
  mounts: string[];
  config: unknown;
}

export interface RunSandboxSpec {
  instanceName: string;
  mounts: string[];
  config: unknown;
}

export interface SandboxHandle {
  adapter: string;
  instanceName: string;
}

export interface WrappedSpawn {
  cmd: string;
  args: string[];
  opts: SpawnOptions & { env: NodeJS.ProcessEnv };
}

export interface SandboxDenial {
  kind: "network" | "credential" | "infra";
  target: string;
}

export interface SandboxReport {
  denied: SandboxDenial[];
  approveHint?: string;
}

export interface SandboxAdapter {
  readonly name: string;
  /** Validate and normalize this adapter's own config sub-block (undefined when absent). Throws Error with a fix-naming message. */
  validateConfig(raw: unknown): unknown;
  preflight(ctx: PreflightCtx): Promise<void>;
  /**
   * Remove leftover instances from an earlier crashed run. Removes only
   * instances whose name starts with `scope.prefix` (this project's
   * `dl-<project>-`); called after the session lock is held.
   */
  cleanupOrphans(scope: { prefix: string }): Promise<void>;
  prepare(run: RunSandboxSpec): Promise<SandboxHandle>;
  wrap(h: SandboxHandle, cmd: string, args: string[], opts: WrappedSpawn["opts"]): WrappedSpawn;
  inspect(h: SandboxHandle, exitCode: number | null): Promise<SandboxReport>;
  /** Idempotent; never throws. */
  teardown(h: SandboxHandle): Promise<void>;
}
