// Jira reset steps, in run order: the loop's own comments, pipeline label,
// status (last: it makes the ticket pollable, so it is skipped when an
// earlier Jira row failed this pass), and a read-only list of follow-up
// tickets. The loop posts under the user's own account, so a comment is the
// loop's only when its first line carries a LOOP_COMMENT_PREFIXES prefix of a
// role AND it was created inside a run window of that same role. Nothing else is ever deleted. Only the two
// pipeline labels (roles.research.triggerLabel / handoffLabel) are touched.
import { readIterations } from "../iteration-log.ts";
import { loopCommentRoles } from "../loop-comments.ts";
import { v2RunsArchive, v2RunsLog } from "../paths.ts";
import type { JiraClient, JiraComment } from "../jira-client.ts";
import type { Role } from "../types.ts";
import type { ResetCtx } from "./context.ts";
import { resetPath, type RunWindow } from "./run-windows.ts";
import type { ResetStep, Survey } from "./step.ts";

const NO_CREDS: Survey = { found: "-", action: null, needsYou: "no credentials" };
const NO_CONFIG: Survey = { found: "-", action: null, needsYou: "no project config" };

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const deleteError = (e: unknown): string => {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number") return String(status);
  return (e instanceof Error ? e.message : String(e)).split("\n")[0].trim();
};

export function jiraSteps(ctx: ResetCtx, windows: () => Promise<RunWindow[]>): ResetStep[] {
  if (ctx.closeRemote) return [];
  // No client: the cause is the missing config when there is none (clients need it).
  const NO_CREDENTIALS: Survey = ctx.config ? NO_CREDS : NO_CONFIG;
  const key = ctx.ticket;
  const inScope = (r: Role): boolean => ctx.role === "all" || ctx.role === r;

  // The status move makes the ticket pollable again, so it runs last and only
  // when every earlier Jira row of this pass came clean: a comments/label
  // survey or run that threw, or a comments row left needing the person,
  // keeps it off the poll. The comments survey (first row) starts a pass.
  let earlierFailed = false;
  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      earlierFailed = true;
      throw e;
    }
  };

  const status: ResetStep = {
    area: "jira",
    name: "status",
    makesPollable: true,
    async survey(): Promise<Survey> {
      if (!ctx.jira) return NO_CREDENTIALS;
      if (!ctx.config) return NO_CONFIG;
      const jira = ctx.jira;
      // The role views copy claimStatus from config.jira (core/config.ts roleView).
      const target = ctx.config.jira.claimStatus.from;
      const current = await jira.getStatus(key);
      if (current === target) return { found: current, action: null };
      const run = async (): Promise<void> => {
        if (earlierFailed) throw new Error("skipped: an earlier Jira step failed");
        await jira.transitionStatus(key, target);
      };
      return { found: current, action: `move to ${target}`, run };
    },
  };

  const label: ResetStep = {
    area: "jira",
    name: "label",
    survey: () => guard(async (): Promise<Survey> => {
      if (!ctx.jira) return NO_CREDENTIALS;
      if (!ctx.config) return NO_CONFIG;
      const jira = ctx.jira;
      const { triggerLabel, handoffLabel } = ctx.config.roles.research;
      const [target, other] = ctx.role === "dev" ? [handoffLabel, triggerLabel] : [triggerLabel, handoffLabel];
      const present = (await jira.getLabels(key)).filter((l) => l === triggerLabel || l === handoffLabel);
      const found = present.length === 0 ? "none" : present.join(", ");
      if (present.includes(target) && !present.includes(other)) return { found, action: null };
      // One PUT; Jira's remove of an absent label is a no-op, so this covers add-only too.
      return { found, action: `swap to ${target}`, run: () => guard(() => jira.swapLabel(key, other, target)) };
    }),
  };

  // Comments listed by an earlier survey stay candidates while they exist:
  // the verify re-survey runs after local steps archived the records and
  // deleted the run dirs the windows came from.
  const listed = new Map<string, Role>();
  // Comment id -> "could not delete <url>: <why>" from the last run.
  const refused = new Map<string, string>();

  const comments: ResetStep = {
    area: "jira",
    name: "loop comments",
    async survey(): Promise<Survey> {
      earlierFailed = false;
      const sv = await guard(() => surveyComments());
      if (sv.needsYou) earlierFailed = true;
      return sv;
    },
  };

  async function surveyComments(): Promise<Survey> {
    if (!ctx.jira) return NO_CREDENTIALS;
    const jira = ctx.jira;
    const ws = await windows();
    const all = await jira.listComments(key);
    const picked: { c: JiraComment; role: Role }[] = [];
    for (const c of all) {
      const at = Date.parse(c.created);
      // A prefix shared by both roles counts for whichever in-scope role's window holds the comment.
      const role = loopCommentRoles(c.firstLine).filter(inScope).find(
        (r) => listed.get(c.id) === r || (Number.isFinite(at) && ws.some((w) => w.role === r && at >= w.from && at <= w.to)),
      );
      if (role !== undefined) picked.push({ c, role });
    }
    if (picked.length === 0) return { found: "none", action: null };
    for (const { c, role } of picked) listed.set(c.id, role);

    const n = picked.length;
    const research = picked.filter((p) => p.role === "research").length;
    const found = `${n} (${research} research, ${n - research} dev)`;
    const details = picked.map(({ c }) => `${hhmm(c.created)} ${c.firstLine}`);
    const failures = picked.map(({ c }) => refused.get(c.id)).filter((f): f is string => f !== undefined);
    if (failures.length > 0) return { found, action: null, needsYou: failures.join("; "), details };

    const targets = picked.map((p) => p.c);
    return { found, action: `delete ${n}`, details, run: () => guard(() => deleteAll(jira, targets)) };
  }

  // Deletes exactly the comments the survey listed; one failure never stops the rest.
  const deleteAll = async (jira: JiraClient, targets: JiraComment[]): Promise<void> => {
    const errors: string[] = [];
    for (const c of targets) {
      try {
        await jira.deleteComment(key, c.id);
        refused.delete(c.id);
      } catch (e) {
        const msg = `could not delete ${c.url}: ${deleteError(e)}`;
        refused.set(c.id, msg);
        errors.push(msg);
      }
    }
    if (errors.length > 0) throw new Error(errors.join("; "));
  };

  const followUps: ResetStep = {
    area: "jira",
    name: "follow-up tickets",
    async survey(): Promise<Survey> {
      if (!ctx.jira) return NO_CREDENTIALS;
      const keys: string[] = [];
      for (const rel of [v2RunsLog(ctx.slug), v2RunsArchive(ctx.slug)]) {
        for (const rec of await readIterations(resetPath(ctx, rel))) {
          if (rec.ticket !== key) continue;
          for (const p of rec.phases) {
            const t = p.role === "dev" ? p.follow_up?.ticket : undefined;
            if (typeof t === "string" && !keys.includes(t)) keys.push(t);
          }
        }
      }
      return { found: keys.length === 0 ? "none" : keys.join(", "), action: null };
    },
  };

  return [comments, label, status, followUps];
}
