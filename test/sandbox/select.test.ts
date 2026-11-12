import { describe, expect, it } from "vitest";
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
    expect(() => selectSandbox(makeV2Config(), "x")).toThrow('--sandbox: unknown sandbox adapter "x"; valid: none');
  });
});
