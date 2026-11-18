// Text guard: the skills name both Atlassian MCP server versions' tools.
// TARS-1640 (2026-11-17): the host connector was /v2/mcp, so the robot's tools
// had the newer names; research's comment was denied and dev read zero comments.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ATLASSIAN_TOOLS } from "../../src/core/atlassian-tools.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const refine = read(".claude/skills/ticket-refine/SKILL.md");
const toPr = read(".claude/skills/ticket-to-pr/SKILL.md");

describe("skills name both Atlassian tool namings", () => {
  it("every renamed research tool appears in ticket-refine under both names", () => {
    for (const t of ATLASSIAN_TOOLS.filter((t) => t.roles.includes("research") && t.v1 && t.v2 && t.v1 !== t.v2)) {
      expect(refine, t.v1).toContain(`\`${t.v1}\``);
      expect(refine, t.v2).toContain(`\`${t.v2}\``);
    }
  });

  it("both skills read comments with listJiraIssueComments where it exists, never trusting getJiraIssue alone", () => {
    for (const t of [refine, toPr]) {
      expect(t).toContain("`listJiraIssueComments`");
      expect(t).toMatch(/never conclude a ticket has no comments from `getJiraIssue`\s+alone/);
    }
  });

  it("the comment-edit rule names both comment tools", () => {
    expect(refine).toMatch(/never pass an existing `commentId` to\s+`addCommentToJiraIssue` or `addOrEditJiraIssueComment`/);
  });

  it("ticket-to-pr: a missing createIssueLink is recorded, never a stop", () => {
    expect(toPr).toMatch(/no `createIssueLink`[\s\S]{0,300}never stop the run for it/);
  });
});
