// main.ts's argument parsing and config preflight, split out so they are
// tested without starting a worker.
//
//   --project <p> | --config <path>   exactly one
//   [--phase worker|research|dev]     default worker (both roles)
//   [--session <name>] [--once] [--stream]
//
// Value flags take `--name value` or `--name=value`. Anything else is an
// error: there is deliberately no way to reach session test seams
// (AcquireOptions._hooks) from the command line.

import type { Config, Role } from "./types.ts";
import { ConfigError, checkLabelVersion, requiredPlaceholderFree } from "./config.ts";

export type Phase = "worker" | Role;

export interface CliArgs {
  phase: Phase;
  project?: string;
  configPath?: string;
  session?: string;
  once: boolean;
  stream: boolean;
}

const PHASES: readonly string[] = ["worker", "research", "dev"];
const VALUE_FLAGS = ["--project", "--config", "--phase", "--session"] as const;
const BOOL_FLAGS = ["--once", "--stream"] as const;

export function parseArgs(argv: string[]): CliArgs {
  const values: Partial<Record<(typeof VALUE_FLAGS)[number], string>> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const flag = name as (typeof VALUE_FLAGS)[number];
      let value: string | undefined;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) value = undefined;
        else i++;
      }
      if (value === undefined || value.length === 0) throw new Error(`main.ts: ${flag} needs a value`);
      values[flag] = value;
    } else if ((BOOL_FLAGS as readonly string[]).includes(arg)) {
      bools.add(arg);
    } else {
      throw new Error(`main.ts: unknown argument ${JSON.stringify(arg)}`);
    }
  }

  const phase = values["--phase"] ?? "worker";
  if (!PHASES.includes(phase)) {
    throw new Error(`main.ts: --phase worker|research|dev (got "${phase}")`);
  }
  const project = values["--project"];
  const configPath = values["--config"];
  if (project && configPath) {
    throw new Error("main.ts: pass either --project <name> or --config <path>, not both.");
  }
  if (!project && !configPath) {
    throw new Error(
      "main.ts requires --project <name> (or --config <path-to-pipeline.<project>.config.json> as a fallback).",
    );
  }
  return {
    phase: phase as Phase,
    project,
    configPath,
    session: values["--session"],
    once: bools.has("--once"),
    stream: bools.has("--stream"),
  };
}

/**
 * Startup checks on a loaded config, in order: every "___" the phase needs
 * is filled (requiredPlaceholderFree), then, in worker mode only, the label
 * version guard (checkLabelVersion): ok:false throws a ConfigError, a
 * minor/patch difference comes back as a warning. This is what keeps the
 * worker off the catalog-ui-* projects (v1 labels) until cutover.
 */
export function preflight(config: Config, phase: Phase, pkgVersion: string): { warnings: string[] } {
  requiredPlaceholderFree(config, phase);
  if (phase !== "worker") return { warnings: [] };
  const guard = checkLabelVersion(config, pkgVersion);
  if (!guard.ok) throw new ConfigError(`--phase worker: ${guard.error}`);
  return { warnings: guard.warning ? [guard.warning] : [] };
}
