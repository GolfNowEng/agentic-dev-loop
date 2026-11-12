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
  cleanupOrphans(): Promise<void>;
  prepare(run: RunSandboxSpec): Promise<SandboxHandle>;
  wrap(h: SandboxHandle, cmd: string, args: string[], opts: WrappedSpawn["opts"]): WrappedSpawn;
  inspect(h: SandboxHandle, exitCode: number | null): Promise<SandboxReport>;
  /** Idempotent; never throws. */
  teardown(h: SandboxHandle): Promise<void>;
}
