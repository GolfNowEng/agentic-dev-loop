import { describe, expect, it } from "vitest";
import { CURRENT_LOG_VERSION } from "../../src/core/types.ts";

// types.ts is almost all type-only (checked by `npx tsc --noEmit`). This is
// its one runtime export, ported from research-loop/src/types.ts.
describe("CURRENT_LOG_VERSION", () => {
  it("is research-loop's current v1 log schema version, 1.1", () => {
    expect(CURRENT_LOG_VERSION).toBe("1.1");
  });
});
