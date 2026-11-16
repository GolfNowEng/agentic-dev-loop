// main.ts's argument parsing and config preflight, split out so they are
// tested without starting a worker.
//
//   --project=<p> | --config=<path>   exactly one
//   [--phase=worker|research|dev]     default worker (both roles)
//   [--session=<name>] [--sandbox=<name>] [--once] [--stream] [--no-dashboard]
//
// Value flags are --name=value only (src/core/flags.ts); the old
// `--name value` form is refused with the replacement. Anything else is an
// error: there is deliberately no way to reach session test seams
// (AcquireOptions._hooks) from the command line.

import type { Config, Role } from "./types.ts";
import { ConfigError, checkLabelVersion, requiredPlaceholderFree } from "./config.ts";
import { parseFlags } from "./flags.ts";

export type Phase = "worker" | Role;

export interface CliArgs {
  phase: Phase;
  project?: string;
  configPath?: string;
  session?: string;
  sandbox?: string;
  once: boolean;
  stream: boolean;
  /** Run the startup checks (config, sandbox preflight) and exit 0, touching no ticket. */
  preflightOnly: boolean;
  /** Don't let the sandbox adapter open its dashboard window. */
  noDashboard: boolean;
}

const PHASES: readonly string[] = ["worker", "research", "dev"];
const SPEC = { values: ["--project", "--config", "--phase", "--session", "--sandbox"], bools: ["--once", "--stream", "--preflight-only", "--no-dashboard"] } as const;

export function parseArgs(argv: string[]): CliArgs {
  const { values, bools } = parseFlags(argv, SPEC, "main.ts");

  const phase = values["--phase"] ?? "worker";
  if (!PHASES.includes(phase)) {
    throw new Error(`main.ts: --phase=worker|research|dev (got "${phase}")`);
  }
  const project = values["--project"];
  const configPath = values["--config"];
  if (project && configPath) {
    throw new Error("main.ts: pass either --project=<name> or --config=<path>, not both.");
  }
  if (!project && !configPath) {
    throw new Error(
      "main.ts requires --project=<name> (or --config=<path-to-pipeline.<project>.config.json> as a fallback).",
    );
  }
  return {
    phase: phase as Phase,
    project,
    configPath,
    session: values["--session"],
    sandbox: values["--sandbox"],
    once: bools.has("--once"),
    stream: bools.has("--stream"),
    preflightOnly: bools.has("--preflight-only"),
    noDashboard: bools.has("--no-dashboard"),
  };
}

/**
 * Startup checks on a loaded config, in order: every "___" the phase needs
 * is filled (requiredPlaceholderFree), then, in worker mode only, the label
 * version guard (checkLabelVersion): ok:false throws a ConfigError. This is
 * what keeps the worker off the catalog-ui-* projects (v1 labels) until
 * cutover. `warnings` stays for future non-fatal checks; none today.
 */
export function preflight(config: Config, phase: Phase, pkgVersion: string): { warnings: string[] } {
  requiredPlaceholderFree(config, phase);
  if (phase !== "worker") return { warnings: [] };
  const guard = checkLabelVersion(config, pkgVersion);
  if (!guard.ok) throw new ConfigError(`--phase=worker: ${guard.error}`);
  return { warnings: [] };
}
