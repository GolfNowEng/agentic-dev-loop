// Cycle step 2: tickets with maxAttemptsPerTicket failed (error/killed)
// attempts of a role are excluded from every poll. A ticket that has just
// reached the cap gets a src-built comment naming the attempts, is moved to
// the bounced status, and gets one "blocked-attempts" record.

import { failedAttempts } from "../core/iteration-log.ts";
import type { Role } from "../core/types.ts";
import { errorMessage } from "../core/run-skill.ts";
import { withSessionSuffix } from "../roles/dev/code-review.ts";
import { append, latestRecord, nowIso, type Ctx } from "./context.ts";

export function buildAttemptsCommentAdf(role: Role, attempts: number, lastDetail: string, bounced: string, session: string): Record<string, unknown> {
  return withSessionSuffix(
    {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "❌ dev-loop - blocked-attempts: ", marks: [{ type: "strong" }] },
            { type: "text", text: `${attempts} failed ${role} attempts; moved to ${bounced}. Last: ${lastDetail}` },
          ],
        },
      ],
    },
    session,
  );
}

/** Adds every attempt-capped ticket to ctx.exclude; acts once on each that just reached the cap. */
export async function enforceAttemptCap(ctx: Ctx): Promise<void> {
  const cap = ctx.deps.config.ceilings.maxAttemptsPerTicket;
  const tickets = [...new Set(ctx.records.map((r) => r.ticket))];
  for (const key of tickets) {
    for (const role of ["research", "dev"] as const) {
      const n = failedAttempts(ctx.records, key, role);
      if (n < cap) continue;
      ctx.exclude.add(key);
      if (latestRecord(ctx.records, key)?.outcome === "blocked-attempts") break;

      const last = ctx.records
        .filter((r) => r.ticket === key)
        .flatMap((r) => r.phases)
        .filter((p) => p.role === role && (p.outcome === "error" || p.outcome === "killed"))
        .at(-1);
      const errors: string[] = [];
      const bounced = ctx.research.statusNames.bounced;
      try {
        await ctx.deps.jira.addComment(key, buildAttemptsCommentAdf(role, n, last?.detail ?? "", bounced, ctx.deps.session.name));
      } catch (err) {
        errors.push(errorMessage(err));
      }
      try {
        await ctx.deps.jira.transitionStatus(key, bounced);
      } catch (err) {
        errors.push(errorMessage(err));
      }
      ctx.log(`[worker] ${key}: ${n} failed ${role} attempts (cap ${cap}) -> ${bounced}`);
      await append(ctx, key, nowIso(ctx), "blocked-attempts", [], {
        detail: `${n} failed ${role} attempts (maxAttemptsPerTicket ${cap})`,
        ...(errors.length > 0 ? { jira_sync_error: errors.join("; ") } : {}),
      });
      break;
    }
  }
}
