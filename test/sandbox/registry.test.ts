import { describe, expect, it } from "vitest";
import { ADAPTERS, DEFAULT_ADAPTER, adapterNames, getAdapter } from "../../src/sandbox/index.ts";
import { noneAdapter } from "../../src/sandbox/none.ts";

describe("sandbox registry", () => {
  it("getAdapter('none') is the none adapter", () => {
    expect(getAdapter("none")).toBe(noneAdapter);
    expect(ADAPTERS.none).toBe(noneAdapter);
  });
  it("getAdapter of an unknown name throws naming the valid ones", () => {
    expect(() => getAdapter("bogus")).toThrow('unknown sandbox adapter "bogus"; valid: none');
  });
  it("DEFAULT_ADAPTER is none", () => {
    expect(DEFAULT_ADAPTER).toBe("none");
    expect(adapterNames()).toEqual(["none"]);
  });
});
