import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.ts";
import { selectSandbox } from "../../src/sandbox/select.ts";
import { makeV2Config } from "../fixtures/config.ts";

describe("selectSandbox", () => {
  it("defaults to the none adapter in enforce mode", () => {
    const sel = selectSandbox(makeV2Config(), undefined);
    expect(sel.adapter.name).toBe("none");
    expect(sel.mode).toBe("enforce");
  });

  it("takes the mode from config.sandbox", () => {
    const cfg = makeV2Config((c) => Object.assign(c, { sandbox: { adapter: "none", mode: "discover" } }));
    expect(selectSandbox(cfg, undefined).mode).toBe("discover");
  });

  it("cliName overrides the config adapter", () => {
    const cfg = makeV2Config((c) => Object.assign(c, { sandbox: { adapter: "none", mode: "discover" } }));
    const sel = selectSandbox(cfg, "none");
    expect(sel.adapter.name).toBe("none");
    expect(sel.mode).toBe("discover");
  });

  it("an unknown cliName throws with the --sandbox: prefix", () => {
    expect(() => selectSandbox(makeV2Config(), "x")).toThrow('--sandbox: unknown sandbox adapter "x"; valid: none, sbx');
  });

  it("settings without an adapter line: none by default, the named adapter with --sandbox", () => {
    const cfg = makeV2Config((c) => Object.assign(c, { sandbox: { mode: "discover", sbx: { kitDir: "/kit" } } }));
    expect(selectSandbox(cfg, undefined).adapter.name).toBe("none");
    const sel = selectSandbox(cfg, "sbx");
    expect(sel.adapter.name).toBe("sbx");
    expect(sel.mode).toBe("discover");
    expect((sel.config as { kitDir: string }).kitDir).toBe("/kit");
  });
});

describe("webtarsthree: sbx is opt-in per run", () => {
  const ROOT = join(import.meta.dirname, "..", "..");

  it("the config has sbx settings but no adapter line, so a plain run uses none", async () => {
    const w = await loadConfig(join(ROOT, "pipeline.webtarsthree.config.json"));
    expect(w.sandbox).not.toHaveProperty("adapter");
    expect(selectSandbox(w, undefined).adapter.name).toBe("none");
    expect(selectSandbox(w, "sbx").adapter.name).toBe("sbx");
  });

  it("npm run sbx:preflight passes --sandbox=sbx", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["sbx:preflight"]).toContain("--sandbox=sbx");
  });
});

describe("webtarsthree: the sandbox gets the Atlassian MCP", () => {
  it("sandbox.sbx.mcp lists atlassian (the skills read Jira through it)", async () => {
    const w = await loadConfig(join(import.meta.dirname, "..", "..", "pipeline.webtarsthree.config.json"));
    expect(selectSandbox(w, "sbx").config).toMatchObject({ mcp: ["atlassian"] });
  });
});
