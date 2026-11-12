import { describe, expect, it } from "vitest";
import { envFileWarning } from "../../src/core/env-file.ts";

const WARNING = "a .env is still in the repo root, inside the spawn cwd; move it out or delete it";
// Placeholder paths only: the helper is pure and touches no file.
const ROOT = "/repo";
const ROOT_ENV = "/repo/.env";
const w = (envFileVar: string | undefined, rootEnvExists: boolean, cwd = ROOT) =>
  envFileWarning({ envFileVar, cwd, rootEnvPath: ROOT_ENV, rootEnvExists });

describe("envFileWarning", () => {
  it("warns when DEVLOOP_ENV_FILE is set and a root .env still exists", () => {
    expect(w("elsewhere/.env", true)).toBe(WARNING);
    expect(w("/home/u/.config/dev-loop/.env", true)).toBe(WARNING);
  });

  it("is silent when DEVLOOP_ENV_FILE is set and the root .env is gone", () => {
    expect(w("elsewhere/.env", false)).toBeNull();
  });

  it("is silent when DEVLOOP_ENV_FILE is unset (the root .env is the default, expected)", () => {
    expect(w(undefined, true)).toBeNull();
    expect(w(undefined, false)).toBeNull();
  });

  it("treats an empty DEVLOOP_ENV_FILE as unset (sh's ${VAR:-.env} falls back to .env)", () => {
    expect(w("", true)).toBeNull();
  });

  it("is silent when DEVLOOP_ENV_FILE resolves to the root .env itself (M4)", () => {
    expect(w(".env", true)).toBeNull();
    expect(w("./.env", true)).toBeNull();
    expect(w(ROOT_ENV, true)).toBeNull();
    expect(w("/repo/sub/../.env", true)).toBeNull();
    // Relative values resolve against the caller's cwd, as node's --env-file does.
    expect(w("../.env", true, "/repo/src")).toBeNull();
    expect(w(".env", true, "/repo/src")).toBe(WARNING);
  });

  it("never includes the variable's value", () => {
    const value = "some-distinctive-location/.env";
    expect(w(value, true)).not.toContain("some-distinctive-location");
  });
});
