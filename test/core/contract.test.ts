// The strings the two phases hand each other through Jira (A1): ticket-refine
// writes the comment titles, ticket-to-pr greps for them. They must stay
// byte-identical, in the code and in both skills.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTRACT } from "../../src/core/contract.ts";
import { pipelineLabels } from "../../src/roles/dev/reconcile.ts";
import { makeV2Config } from "../fixtures/config.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SKILLS = {
  "ticket-refine (writer)": ".claude/skills/ticket-refine/SKILL.md",
  "ticket-to-pr (reader)": ".claude/skills/ticket-to-pr/SKILL.md",
} as const;

const codePoints = (s: string): number[] => [...s].map((c) => c.codePointAt(0)!);

describe("CONTRACT", () => {
  it("has exactly the pinned values", () => {
    expect(CONTRACT).toEqual({
      researchPass: "✅ research-loop -",
      researchFail: "❌ research-loop -",
      v1ResearchLabel: "pipeline:research",
      v1DevLabel: "pipeline:dev",
    });
  });

  it("comment titles are U+2705 / U+274C, one space, `research-loop`, and a trailing ` -`", () => {
    const tail = codePoints(" research-loop -");
    expect(codePoints(CONTRACT.researchPass)).toEqual([0x2705, ...tail]);
    expect(codePoints(CONTRACT.researchFail)).toEqual([0x274c, ...tail]);
  });

  for (const [label, rel] of Object.entries(SKILLS)) {
    const bytes = readFileSync(resolve(REPO_ROOT, rel));
    for (const key of ["researchPass", "researchFail"] as const) {
      it(`${label} contains CONTRACT.${key} byte-for-byte`, () => {
        expect(bytes.indexOf(Buffer.from(CONTRACT[key], "utf8"))).toBeGreaterThanOrEqual(0);
      });
    }
    it(`${label} never writes an icon with a variation selector (U+FE0F), which would not match`, () => {
      const text = bytes.toString("utf8");
      expect(text).not.toMatch(/[✅❌]️/u);
    });
  }

  it("reconcile strips the v1 labels from CONTRACT", () => {
    const labels = pipelineLabels(makeV2Config());
    expect(labels).toContain(CONTRACT.v1ResearchLabel);
    expect(labels).toContain(CONTRACT.v1DevLabel);
  });
});
