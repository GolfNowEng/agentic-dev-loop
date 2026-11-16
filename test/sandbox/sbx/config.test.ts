import { describe, expect, it } from "vitest";
import { DEFAULT_ENV_ALLOW, validateSbxConfig } from "../../../src/sandbox/sbx/config.ts";

describe("validateSbxConfig", () => {
  it("requires kitDir", () => {
    expect(() => validateSbxConfig(undefined)).toThrow("sandbox.sbx: kitDir is required");
    expect(() => validateSbxConfig({})).toThrow("sandbox.sbx: kitDir is required");
  });
  it("requires an absolute kitDir", () => {
    expect(() => validateSbxConfig({ kitDir: "kit" })).toThrow("sandbox.sbx: kitDir must be an absolute path");
  });
  it("rejects unknown keys", () => {
    expect(() => validateSbxConfig({ kitDir: "/k", x: 1 })).toThrow('sandbox.sbx: unknown key "x"');
  });
  it("validates memory", () => {
    expect(validateSbxConfig({ kitDir: "/k", memory: "4g" }).memory).toBe("4g");
    expect(() => validateSbxConfig({ kitDir: "/k", memory: "lots" })).toThrow(/memory/);
  });
  it("defaults and appends envAllow, deduplicated", () => {
    expect(validateSbxConfig({ kitDir: "/k" }).envAllow).toEqual(DEFAULT_ENV_ALLOW);
    const got = validateSbxConfig({ kitDir: "/k", envAllow: ["FOO", DEFAULT_ENV_ALLOW[0], "FOO"] }).envAllow;
    expect(got).toEqual([...DEFAULT_ENV_ALLOW, "FOO"]);
  });
  it("rejects secret-shaped env names", () => {
    expect(() => validateSbxConfig({ kitDir: "/k", envAllow: ["MY_api_key"] })).toThrow('sandbox.sbx: envAllow may not pass "MY_api_key" (secret-shaped)');
  });
  it("rejects envAllow entries that are not bare names", () => {
    for (const bad of ["FOO=bar", "", "1A", "A B"]) {
      expect(() => validateSbxConfig({ kitDir: "/k", envAllow: [bad] })).toThrow(`sandbox.sbx: envAllow entry "${bad}" must be a bare env var name`);
    }
  });
  it("accepts an optional template image reference", () => {
    expect(validateSbxConfig({ kitDir: "/k" }).template).toBeUndefined();
    expect(validateSbxConfig({ kitDir: "/k", template: "docker.io/library/dev-loop-sbx:v1" }).template).toBe("docker.io/library/dev-loop-sbx:v1");
  });
  it("rejects a template that is not a plain image reference", () => {
    for (const bad of ["", "has space:v1", "-t", "x;rm", 3]) {
      expect(() => validateSbxConfig({ kitDir: "/k", template: bad })).toThrow("sandbox.sbx: template must be an image reference");
    }
  });
});
