// The one command-line flag parser every dev-loop CLI uses (the loop,
// reset-project, the scripts/ and evals/ tools).
//
// The rule: a flag that takes a value is written `--key=value`; a boolean
// flag is bare (`--once`). The old `--key value` form is refused with the
// exact replacement, so a stale command fails loudly instead of silently
// doing something else. A flag given twice, a value on a boolean, and any
// unknown flag are errors.
//
// Plain erasable TypeScript, so the .mjs scripts can import it directly.

export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagError";
  }
}

export interface FlagSpec {
  /** Flags written --key=value, e.g. "--project". */
  values: readonly string[];
  /** Bare boolean flags, e.g. "--once". */
  bools: readonly string[];
  /** Allow non-flag arguments (subcommands, keys). Default false. */
  positionals?: boolean;
}

export interface ParsedFlags {
  values: Record<string, string>;
  bools: Set<string>;
  positionals: string[];
}

/** Parse `argv` against `spec`. `prog` prefixes every error message. Throws FlagError. */
export function parseFlags(argv: readonly string[], spec: FlagSpec, prog: string): ParsedFlags {
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const positionals: string[] = [];
  const fail = (msg: string): never => {
    throw new FlagError(`${prog}: ${msg}`);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (spec.values.includes(name)) {
      if (eq === -1) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) fail(`${name} needs a value: use ${name}=<value>`);
        fail(`${name} takes its value after "=": use ${name}=${next}`);
      }
      const value = arg.slice(eq + 1);
      if (value.length === 0) fail(`${name} needs a value: use ${name}=<value>`);
      if (name in values) fail(`${name} given twice`);
      values[name] = value;
    } else if (spec.bools.includes(name)) {
      if (eq !== -1) fail(`${name} takes no value (got "${arg}")`);
      if (bools.has(name)) fail(`${name} given twice`);
      bools.add(name);
    } else if (spec.positionals && !arg.startsWith("-")) {
      positionals.push(arg);
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { values, bools, positionals };
}
