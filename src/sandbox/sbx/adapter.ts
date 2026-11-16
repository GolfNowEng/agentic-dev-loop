// The sbx (Docker Sandboxes) adapter. The only place sbx commands, flags and
// output formats are known. Every call goes through an injected SbxRunner, so
// tests never run the real binary. Verified against sbx v0.53.0 (spec
// "Verified before step 3").

import { readdirSync, realpathSync } from "node:fs";
import type { SandboxAdapter, SandboxDenial, SandboxHandle } from "../types.ts";
import { DEFAULT_ENV_ALLOW, validateSbxConfig, type SbxConfig } from "./config.ts";
import type { SbxResult, SbxRunner } from "./run.ts";

/** `sbx create` pulls an image on a cold cache; ~5 s when cached. */
export const CREATE_TIMEOUT_MS = 180_000;

const APPROVE_HEADING = "Review, then run yourself if you approve:";
/** Ordered so a failure is attributed by which version lines appeared before it. */
const PREFLIGHT_CHECK = "node --version && git --version && jq --version && gh auth status";
/** sbx exec's own failure (e.g. a missing sandbox); the inner command's code passes through otherwise. */
const EXEC_INFRA_EXIT = 125;

export interface SbxAdapterDeps {
  run: SbxRunner;
  realpath?: (p: string) => string;
  hostNodeMajor?: number;
  /** The host env preflight checks the model-alias names against (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Non-fatal preflight warnings (default console.error). */
  warn?: (m: string) => void;
}

const firstLine = (s: string): string => s.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
const why = (r: SbxResult): string => (r.timedOut ? "timeout" : String(r.code));

/** The validated sub-block select.ts passed through. Defensive: a missing kitDir is a wiring bug. */
function sbxConfig(raw: unknown): SbxConfig {
  const o = raw as Partial<SbxConfig> | null | undefined;
  if (typeof o !== "object" || o === null || typeof o.kitDir !== "string") {
    throw new Error("sandbox.sbx: no kitDir in the adapter config (was it validated?)");
  }
  return {
    kitDir: o.kitDir,
    envAllow: Array.isArray(o.envAllow) ? o.envAllow : [],
    ...(o.memory !== undefined ? { memory: o.memory } : {}),
    ...(o.template !== undefined ? { template: o.template } : {}),
  };
}

function createArgs(name: string, cfg: SbxConfig, mounts: string[]): string[] {
  return [
    "create", "--name", name, "--no-progress", "--no-input",
    ...(cfg.memory ? ["--memory", cfg.memory] : []),
    // A saved local template must not be pulled; the kit still supplies network policy and credentials.
    ...(cfg.template ? ["-t", cfg.template, "--pull", "never"] : []),
    "claude", "--kit", cfg.kitDir, ...mounts,
  ];
}

/** Each blocked[].host, or undefined when the log isn't the expected shape. */
function blockedHosts(stdout: string): string[] | undefined {
  try {
    const log = JSON.parse(stdout) as { blocked?: unknown } | null;
    if (typeof log !== "object" || log === null || !Array.isArray(log.blocked)) return undefined;
    return log.blocked.flatMap((b) => (typeof b === "object" && b !== null && typeof (b as { host?: unknown }).host === "string" ? [(b as { host: string }).host] : []));
  } catch {
    return undefined;
  }
}

/** `example.org:443` -> `example.org`; leaves a bare host (or a bracketed IPv6 without a port) alone. */
const stripPort = (host: string): string => host.replace(/:\d+$/, "");

/**
 * A blocked host is whatever the sandboxed agent tried to reach, so it is
 * untrusted: only a plain DNS name or a bracketed IPv6 literal may go into a
 * command a human is asked to run.
 */
const HINTABLE_HOST = [/^[A-Za-z0-9.-]+$/, /^\[[0-9a-fA-F:]+\]$/];
const isHintable = (host: string): boolean => HINTABLE_HOST.some((re) => re.test(host));

export function makeSbxAdapter(deps: SbxAdapterDeps): SandboxAdapter {
  const { run } = deps;
  const realpath = deps.realpath ?? realpathSync.native;
  const hostNodeMajor = deps.hostNodeMajor ?? Number(process.versions.node.split(".")[0]);
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((m: string) => console.error(m));
  // The handle type is adapter-neutral, so prepare remembers each handle's envAllow here for wrap.
  const handleEnvAllow = new WeakMap<SandboxHandle, string[]>();

  async function create(name: string, cfg: SbxConfig, mounts: string[]): Promise<void> {
    const r = await run(createArgs(name, cfg, mounts), { timeoutMs: CREATE_TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) throw new Error(`sbx create failed (${why(r)}): ${firstLine(r.stderr)}`);
  }

  async function remove(name: string): Promise<void> {
    const r = await run(["rm", "-f", name]);
    if (r.code === 0 && !r.timedOut) return;
    if (r.stderr.includes("not found")) return;
    throw new Error(`sbx rm failed (${why(r)}): ${firstLine(r.stderr)}`);
  }

  return {
    name: "sbx",

    validateConfig: (raw) => validateSbxConfig(raw),

    async preflight(ctx) {
      // sbx canonicalizes a mount's case but the container is case-sensitive.
      for (const p of [...ctx.mounts, ctx.cwd]) {
        const real = realpath(p);
        if (real !== p) {
          const fromConfig = p !== ctx.cwd ? "; if it comes from targetRepo.path, fix the case in the config" : "";
          throw new Error(`sandbox paths must match the disk's real case: "${p}" is "${real}" on disk; cd into the real path and restart${fromConfig}`);
        }
      }
      const cfg = sbxConfig(ctx.config);
      // Names only, never values.
      const unsetModels = DEFAULT_ENV_ALLOW.filter((n) => /_MODEL$/.test(n) && !env[n]);
      if (unsetModels.length > 0) {
        warn(
          `WARNING: ${unsetModels.join(", ")} not set; inside the sandbox the sonnet/opus/haiku aliases fall back to stock model ids. Set them in your DEVLOOP_ENV_FILE.`,
        );
      }
      let entries: string[] = [];
      try {
        entries = readdirSync(cfg.kitDir);
      } catch {
        // Missing or unreadable: same refusal as an empty dir.
      }
      if (!entries.some((e) => e.endsWith(".yaml"))) throw new Error(`sandbox.sbx.kitDir "${cfg.kitDir}" has no kit yaml`);

      const name = ctx.instanceName;
      try {
        try {
          await create(name, cfg, ctx.mounts);
        } catch (err) {
          throw new Error(`sbx preflight failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const r = await run(["exec", name, "sh", "-c", PREFLIGHT_CHECK]);
        if (r.code === 0 && !r.timedOut && nodeMajor(r.stdout) === hostNodeMajor) return;
        if (r.timedOut || r.code === EXEC_INFRA_EXIT) throw new Error(`sbx preflight failed: ${firstLine(r.stderr)}`);
        if (nodeMajor(r.stdout) !== hostNodeMajor) {
          throw new Error(`sandbox image has no node ${hostNodeMajor}: add node to the kit (see docs/sandbox-sbx.md)`);
        }
        // The && chain stops at the first failure; the last version line printed names the step after it.
        if (/^jq-/m.test(r.stdout)) {
          throw new Error("gh is not logged in inside the sandbox: run sbx secret set github (see docs/sandbox-sbx.md)");
        }
        if (/^git version /m.test(r.stdout)) {
          throw new Error("sandbox image has no jq: add jq to the kit (see docs/sandbox-sbx.md)");
        }
        throw new Error(`sbx preflight failed: ${firstLine(r.stderr)}`);
      } finally {
        await remove(name).catch(() => {});
      }
    },

    async cleanupOrphans({ prefix }) {
      const r = await run(["ls", "--json"]);
      if (r.code !== 0 || r.timedOut) throw new Error(`sbx ls failed: (${why(r)}) ${firstLine(r.stderr)}`);
      let names: string[];
      try {
        const list = JSON.parse(r.stdout) as unknown;
        if (!Array.isArray(list)) throw new Error("not an array");
        names = list.flatMap((s) => (typeof s === "object" && s !== null && typeof (s as { name?: unknown }).name === "string" ? [(s as { name: string }).name] : []));
      } catch (err) {
        throw new Error(`sbx ls failed: unparseable --json output (${err instanceof Error ? err.message : String(err)})`);
      }
      for (const n of names) if (n.startsWith(prefix)) await remove(n);
    },

    async prepare(spec) {
      const cfg = sbxConfig(spec.config);
      await create(spec.instanceName, cfg, spec.mounts);
      const h: SandboxHandle = { adapter: "sbx", instanceName: spec.instanceName };
      handleEnvAllow.set(h, cfg.envAllow);
      return h;
    },

    wrap(h, cmd, args, opts) {
      // Env passes by NAME only; sbx exec reads each value from its own env (opts.env).
      const envAllow = handleEnvAllow.get(h) ?? [];
      const envArgs = envAllow.filter((n) => n in opts.env).flatMap((n) => ["-e", n]);
      const cwdArgs = opts.cwd !== undefined ? ["-w", String(opts.cwd)] : [];
      return { cmd: "sbx", args: ["exec", ...cwdArgs, ...envArgs, h.instanceName, cmd, ...args], opts };
    },

    async inspect(h, exitCode) {
      const denied: SandboxDenial[] = [];
      if (exitCode === EXEC_INFRA_EXIT) denied.push({ kind: "infra", target: "sbx exec" });
      // policy log still answers for a removed sandbox, so this works after teardown.
      const r = await run(["policy", "log", h.instanceName, "--json"]);
      const hosts = r.code === 0 && !r.timedOut ? blockedHosts(r.stdout) : undefined;
      if (hosts === undefined) {
        denied.push({ kind: "infra", target: "policy log" });
        return { denied };
      }
      for (const host of new Set(hosts)) denied.push({ kind: "network", target: host });
      if (hosts.length === 0) return { denied };
      const bare = [...new Set(hosts.map(stripPort))];
      const lines = bare.filter(isHintable).map((x) => `sbx policy allow network ${x}`);
      if (bare.some((x) => !isHintable(x))) {
        lines.push(`(not shown: a blocked host with unexpected characters; see sbx policy log ${h.instanceName})`);
      }
      return { denied, approveHint: [APPROVE_HEADING, ...lines].join("\n") };
    },

    teardown: (h) => remove(h.instanceName),
  };
}

function nodeMajor(stdout: string): number | undefined {
  const m = /^v(\d+)\./m.exec(stdout);
  return m ? Number(m[1]) : undefined;
}
