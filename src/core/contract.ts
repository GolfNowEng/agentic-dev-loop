// The strings the two phases hand each other through Jira (design
// constraint A1). ticket-refine writes the comment titles and ticket-to-pr
// greps for them, so they must stay byte-identical. test/core/contract.test.ts
// pins every value here in both SKILL.md files.

export const CONTRACT = {
  /** Title prefix of a passing research comment (U+2705). */
  researchPass: "✅ research-loop -",
  /** Title prefix of a research bounce comment (U+274C). */
  researchFail: "❌ research-loop -",
  /** The v1 research trigger label (catalog-ui-* until cutover; reconcile strips it). */
  v1ResearchLabel: "pipeline:research",
  /** The v1 dev trigger label. */
  v1DevLabel: "pipeline:dev",
} as const;
