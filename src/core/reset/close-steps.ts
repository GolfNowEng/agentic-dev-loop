// --close-remote's rows: close the Jira ticket, its mirror GitHub Issue and
// the recorded PR (remote-close.ts's three parts). Surveys only read. The PR
// URL is looked up once, on the first survey, before any local step archives
// the records it comes from (the runner surveys every row before running any).
import { findRecordedPrUrlAcross } from "../iteration-log.ts";
import { closeJiraTicket, closeMirrorIssue, closeRecordedPr } from "../remote-close.ts";
import type { ResetCtx } from "./context.ts";
import type { ResetStep, Survey } from "./step.ts";

export function closeSteps(ctx: ResetCtx): ResetStep[] {
  const key = ctx.ticket;
  // No client: the cause is the missing config when there is none (clients need it).
  const NO_CREDENTIALS: Survey = { found: "-", action: null, needsYou: ctx.config ? "no credentials" : "no project config" };
  let prUrl: Promise<string | null> | null = null;
  const recordedPr = (): Promise<string | null> => (prUrl ??= findRecordedPrUrlAcross(ctx.slug, key, ctx.root));

  // closeTicket is idempotent but the client can't read a status category,
  // so the ticket row proposes "close" until it closed in this process
  // (the verify pass re-surveys this same instance).
  let ticketClosed: string | null = null;

  const ticket: ResetStep = {
    area: "jira",
    name: "close ticket",
    async survey(): Promise<Survey> {
      await recordedPr();
      if (!ctx.jira) return NO_CREDENTIALS;
      const jira = ctx.jira;
      const status = await jira.getStatus(key);
      if (ticketClosed !== null) return { found: `${status} (${ticketClosed})`, action: null };
      return {
        found: status,
        action: "close (done transition)",
        run: async () => {
          const r = await closeJiraTicket(jira, key);
          if (r.jira === "no-transition") throw new Error("no done-category transition from its current status");
          ticketClosed = r.jira === "closed" ? `closed via ${r.jiraDetail}` : "already done";
        },
      };
    },
  };

  const issue: ResetStep = {
    area: "github",
    name: "close mirror Issue",
    async survey(): Promise<Survey> {
      await recordedPr();
      if (!ctx.github) return NO_CREDENTIALS;
      const github = ctx.github;
      const issues = await github.findIssuesByJiraKey(key);
      const open = issues.filter((i) => i.state === "OPEN");
      if (open.length === 0) return { found: issues.length === 0 ? "none" : `${issues.map((i) => `#${i.number}`).join(", ")} (closed)`, action: null };
      return {
        found: open.map((i) => `#${i.number} (open)`).join(", "),
        action: "close (not planned)",
        run: async () => {
          await closeMirrorIssue(github, key);
        },
      };
    },
  };

  // closePr is idempotent ("already-closed" for closed or merged PRs); the
  // client has no PR state read, so the row proposes it until done here.
  let prClosed: string | null = null;
  const pr: ResetStep = {
    area: "github",
    name: "close PR",
    async survey(): Promise<Survey> {
      const url = await recordedPr();
      if (url === null) return { found: "none", action: null };
      if (!ctx.github) return { ...NO_CREDENTIALS, found: url };
      const github = ctx.github;
      if (prClosed !== null) return { found: `${url} (${prClosed})`, action: null };
      return {
        found: url,
        action: "close",
        run: async () => {
          prClosed = await closeRecordedPr(github, url);
        },
      };
    },
  };

  return [ticket, issue, pr];
}
