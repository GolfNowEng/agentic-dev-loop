import type { CodeReviewFieldsConfig, Verdict } from "../../core/types.ts";

/**
 * Build the QA-notes Atlassian Document (ADF) for Jira's QA Notes field
 * (customfield_14226).
 *
 * When the skill reported `qa_notes` (sequential manual-testing steps --
 * see the Verdict type's own doc comment), render a bold "Manual testing
 * steps:" header followed by an ordered list, one listItem per entry --
 * the same ADF shape the retired interactive qa-notes/push-branch skills
 * built by hand. Any entry starting with "Expected:" gets that prefix
 * bold-marked, matching that same convention, so a human QA reviewer can
 * scan action steps vs. expected results at a glance. This is genuinely
 * useful, step-by-step content -- distinct from, and never derived from,
 * the PR body's own terse "## QA Notes" pass/fail summary.
 *
 * When `qa_notes` is absent or empty (older verdicts, or a bounce with no
 * notes to give), fall back to the previous PR-link stub.
 *
 * customfield_14226 is a rich-text field: Jira rejects a plain string for
 * it ("Operation value must be an Atlassian Document"), confirmed against
 * a real transition attempt -- so this always returns a full ADF doc, not
 * a string.
 */
export function buildQaNotesAdf(verdict: Verdict): Record<string, unknown> {
  if (verdict.qa_notes && verdict.qa_notes.length > 0) {
    return {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Manual testing steps:", marks: [{ type: "strong" }] }],
        },
        {
          type: "orderedList",
          attrs: { order: 1 },
          content: verdict.qa_notes.map((step) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: qaNoteStepContent(step) }],
          })),
        },
      ],
    };
  }

  const lines = [`PR: ${verdict.pr ?? "(none)"}`, `Verify loops: ${verdict.verify_loops}`];
  return {
    type: "doc",
    version: 1,
    content: lines.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

/**
 * Split one qa_notes entry into ADF text nodes. An "Expected:" prefix gets
 * its own bold-marked node followed by a plain node for the rest of the
 * line; every other entry is a single plain node.
 */
function qaNoteStepContent(step: string): Array<Record<string, unknown>> {
  const EXPECTED_PREFIX = "Expected:";
  if (step.startsWith(EXPECTED_PREFIX)) {
    return [
      { type: "text", text: EXPECTED_PREFIX, marks: [{ type: "strong" }] },
      { type: "text", text: step.slice(EXPECTED_PREFIX.length) },
    ];
  }
  return [{ type: "text", text: step }];
}

/**
 * Build the Jira comment ADF posted on a genuine bounce (see
 * runLoopIteration's Blocked branch), so a human reading the ticket sees
 * why it's blocked without having to go find this repo's local
 * runs.jsonl -- the same evidence already lands in the run log, this is
 * just the copy that reaches Jira. Bold "failure_category" label followed
 * by the skill's own one-line detail, matching the plain-paragraph shape
 * of buildQaNotesAdf's PR-link-stub fallback (no rich structure needed for
 * a single line). Opens with the `{✅|❌} dev-loop - <short context>`
 * convention (matching research-loop's own comment-title convention, per
 * docs/future-enhancements.md's "Simplify Jira/GitHub comment templates"
 * entry) as its bold first line, using `failure_category` directly as the
 * short-context text since it's already a closed, human-readable-enough
 * enum value for this repo's own bounce comment (research-loop's own
 * version writes a fuller plain-language phrase; this repo's existing
 * convention has always used the bare category name and this change
 * doesn't alter that, only the leading icon+repo-name prefix).
 */
export function buildBounceCommentAdf(verdict: Verdict): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `❌ dev-loop - ${verdict.failure_category}: `, marks: [{ type: "strong" }] },
          { type: "text", text: verdict.detail },
        ],
      },
    ],
  };
}

/**
 * Build the `fields` payload for the Code Review transition, mirroring
 * the interactive push-branch skill's own Jira write: it unconditionally
 * declares "No Impact" on the PII/security inventory field (no real PII
 * assessment happens here or in push-branch today -- a known gap, not
 * solved by this pipeline), plus the generated QA notes.
 */
export function buildCodeReviewFields(
  view: { codeReviewFields: CodeReviewFieldsConfig },
  qaNotesAdf: Record<string, unknown>,
): Record<string, unknown> {
  const { piiField, piiNoImpactOptionId, qaNotesField } = view.codeReviewFields;
  return {
    [piiField]: [{ id: piiNoImpactOptionId }],
    [qaNotesField]: qaNotesAdf,
  };
}
