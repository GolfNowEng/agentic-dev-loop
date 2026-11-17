import { describe, expect, it } from "vitest";
import { loopCommentRole, loopCommentRoles } from "../../src/core/loop-comments.ts";
import { CONTRACT } from "../../src/core/contract.ts";

describe("loop comment prefixes", () => {
  it("matches every real poster's first line", () => {
    expect(loopCommentRoles(`${CONTRACT.researchPass} refined, ready for dev`)).toEqual(["research"]);
    expect(loopCommentRoles(`## ${CONTRACT.researchFail} scope too large, needs split`)).toEqual(["research"]);
    expect(loopCommentRoles("❌ dev-loop - test-failure: 3 tests red")).toEqual(["dev"]); // code-review.ts
    expect(loopCommentRoles("❌ dev-loop - blocked-attempts: 3 failed dev attempts")).toEqual(["dev"]); // attempts.ts
    expect(loopCommentRoles("dev-loop could not start this ticket: moving it to In Progress requires X")).toEqual(["research", "dev"]); // cycle-steps.ts
  });

  it("never matches a look-alike", () => {
    for (const l of ["✅ research-loopX done", "✅ dev-loop looks good", "❌ dev-loop", "research-loop - x", "dev-loop could not start", "Looks good"]) {
      expect(loopCommentRoles(l)).toEqual([]);
      expect(loopCommentRole(l)).toBeNull();
    }
  });
});
