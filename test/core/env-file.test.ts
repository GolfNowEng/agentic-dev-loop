import { describe, expect, it } from "vitest";
import { envFileWarning } from "../../src/core/env-file.ts";

const WARNING = "a .env is still in the repo root, inside the spawn cwd; move it out or delete it";

describe("envFileWarning", () => {
  it("warns when DEVLOOP_ENV_FILE is set and a root .env still exists", () => {
    expect(envFileWarning("elsewhere/.env", true)).toBe(WARNING);
  });

  it("is silent when DEVLOOP_ENV_FILE is set and the root .env is gone", () => {
    expect(envFileWarning("elsewhere/.env", false)).toBeNull();
  });

  it("is silent when DEVLOOP_ENV_FILE is unset (the root .env is the default, expected)", () => {
    expect(envFileWarning(undefined, true)).toBeNull();
    expect(envFileWarning(undefined, false)).toBeNull();
  });

  it("treats an empty DEVLOOP_ENV_FILE as unset (sh's ${VAR:-.env} falls back to .env)", () => {
    expect(envFileWarning("", true)).toBeNull();
  });

  it("never includes the variable's value", () => {
    const value = "some-distinctive-location/.env";
    expect(envFileWarning(value, true)).not.toContain("some-distinctive-location");
  });
});
