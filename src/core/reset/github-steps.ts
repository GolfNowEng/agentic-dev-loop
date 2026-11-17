// GitHub reset step: a read-only report of the ticket's mirror Issue(s).
// Reset never closes, reopens or comments on an Issue (only --close-remote
// closes one, in Task 8's close rows). Research and all scope only.
import type { GitHubIssue } from "../github-client.ts";
import type { ResetCtx } from "./context.ts";
import type { ResetStep, Survey } from "./step.ts";

const describeIssue = (i: GitHubIssue): string => {
  if (i.state === "OPEN") return `#${i.number} (open)`;
  return i.stateReason === "NOT_PLANNED" ? `#${i.number} (closed, not planned)` : `#${i.number} (closed)`;
};

export function githubSteps(ctx: ResetCtx): ResetStep[] {
  if (ctx.role === "dev") return [];
  const mirror: ResetStep = {
    area: "github",
    name: "mirror Issue",
    async survey(): Promise<Survey> {
      if (!ctx.github) return { found: "-", action: null, needsYou: "no credentials" };
      const issues = await ctx.github.findIssuesByJiraKey(ctx.ticket);
      return { found: issues.length === 0 ? "none" : issues.map(describeIssue).join(", "), action: null };
    },
  };
  return [mirror];
}
