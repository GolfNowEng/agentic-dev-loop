import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../../src/sandbox/index.ts";
import { noneAdapter } from "../../src/sandbox/none.ts";
import type { SandboxAdapter } from "../../src/sandbox/types.ts";

const RUN = { instanceName: "dev-loop-TEST-1", mounts: ["/tmp/repo"], config: undefined };

describe.each(Object.values(ADAPTERS))("sandbox adapter contract: $name", (adapter: SandboxAdapter) => {
  it("prepare returns a handle naming this adapter and the instance", async () => {
    const h = await adapter.prepare(RUN);
    expect(h.adapter).toBe(adapter.name);
    expect(h.instanceName).toBe(RUN.instanceName);
  });

  it("wrap preserves the claude args in order", async () => {
    const h = await adapter.prepare(RUN);
    const args = ["-p", "--model", "sonnet", "hello"];
    const w = adapter.wrap(h, "claude", args, { cwd: "/tmp/repo", env: { A: "1" } });
    const hay = w.args;
    const found = hay.some((_, i) => args.every((a, j) => hay[i + j] === a));
    expect(found).toBe(true);
  });

  it("wrap never adds an env key whose value is not in the input env", async () => {
    const h = await adapter.prepare(RUN);
    const env = { A: "1", B: "2" };
    const w = adapter.wrap(h, "claude", ["-p"], { env });
    const inputValues = new Set(Object.values(env));
    for (const [k, v] of Object.entries(w.opts.env)) {
      if (!(k in env)) expect(inputValues.has(v as string), `new env key ${k}`).toBe(true);
    }
  });

  it("inspect returns a SandboxReport with a denied array", async () => {
    const h = await adapter.prepare(RUN);
    const r = await adapter.inspect(h, 0);
    expect(Array.isArray(r.denied)).toBe(true);
  });

  it("teardown is idempotent and never throws", async () => {
    const h = await adapter.prepare(RUN);
    await expect(adapter.teardown(h)).resolves.toBeUndefined();
    await expect(adapter.teardown(h)).resolves.toBeUndefined();
  });

  it("cleanupOrphans accepts a prefix scope and resolves", async () => {
    await expect(adapter.cleanupOrphans({ prefix: "dl-test-" })).resolves.toBeUndefined();
  });

  it("validateConfig(undefined) does not throw", () => {
    expect(() => adapter.validateConfig(undefined)).not.toThrow();
  });
});

describe("none adapter", () => {
  it("wrap returns cmd/args/opts unchanged", async () => {
    const h = await noneAdapter.prepare(RUN);
    const args = ["-p", "x"];
    const opts = { cwd: "/tmp", env: { A: "1" } };
    const w = noneAdapter.wrap(h, "claude", args, opts);
    expect(w.cmd).toBe("claude");
    expect(w.args).toBe(args);
    expect(w.opts).toBe(opts);
  });

  it("inspect reports nothing denied", async () => {
    const h = await noneAdapter.prepare(RUN);
    expect(await noneAdapter.inspect(h, 0)).toEqual({ denied: [] });
  });
});
