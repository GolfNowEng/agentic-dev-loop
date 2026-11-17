// Local reset steps: run records, run dirs, dead-lock in-flight, recent-window hold.
// The three acting steps share one executeReset run (see localSteps).
import { basename, resolve } from "node:path";
import { executeReset, planReset, type ResetPlan } from "../reset-project.ts";
import { DEFAULT_RECENT_WINDOW_MS, readIterations, recentlyEnded } from "../iteration-log.ts";
import { resolveRepoPath, v2RunsLog } from "../paths.ts";
import type { ResetCtx } from "./context.ts";
import type { ResetStep, Survey } from "./step.ts";

export function localSteps(ctx: ResetCtx): ResetStep[] {
  let plan: ResetPlan | null = null;
  let executed = false;

  // Fresh plan per survey; a new survey re-arms the shared run.
  const surveyPlan = async (): Promise<ResetPlan> => {
    plan = await planReset({
      project: ctx.slug, ticket: ctx.ticket, role: ctx.role, config: ctx.config, root: ctx.root,
      isAlive: ctx.isAlive, ignoreLiveWorker: true, skipWorktrees: true,
    });
    executed = false;
    return plan;
  };
  // The first run() of a pass executes the latest plan; later ones are no-ops.
  const run = async (): Promise<void> => {
    if (executed || plan === null) return;
    executed = true;
    try {
      // Note: executeReset re-checks lock liveness with the real isProcessAlive, not ctx.isAlive.
      await executeReset(plan);
    } catch (e) {
      executed = false; // a failed execute is not done
      throw e;
    }
  };

  const records: ResetStep = {
    area: "local",
    name: "run records",
    async survey(): Promise<Survey> {
      const p = await surveyPlan();
      const n = p.recordsToArchive;
      const m = p.refusedRecords.length;
      const found = (n === 0 ? "none" : `${n} records in runs/v2/${ctx.slug}`) + (m > 0 ? `, ${m} refused` : "");
      const details = p.refusedRecords.map((r) => `kept: ${r.ticket} record (${r.reason})`);
      if (n === 0) {
        return m > 0 ? { found, action: null, needsYou: "other role landed; --include-cross-role", details } : { found, action: null };
      }
      return { found, action: `archive ${n}`, run, ...(m > 0 ? { details } : {}) };
    },
  };

  const dirs: ResetStep = {
    area: "local",
    name: "run dirs",
    async survey(): Promise<Survey> {
      const p = await surveyPlan();
      const n = p.runDirsToRemove.length;
      if (n === 0) return { found: "none", action: null };
      return { found: p.runDirsToRemove.map((d) => basename(d)).join(", "), action: `delete ${n}`, run };
    },
  };

  const lock: ResetStep = {
    area: "local",
    name: "session lock in-flight",
    async survey(): Promise<Survey> {
      const p = await surveyPlan();
      if (p.flightsToClear.length === 0) return { found: "none", action: null };
      const found = p.flightsToClear.map((f) => `${basename(f)} (holder dead) -> ${ctx.role} run`).join(", ");
      return { found, action: "clear", run };
    },
  };

  const hold: ResetStep = {
    area: "local",
    name: "recent-window hold",
    async survey(): Promise<Survey> {
      const rel = v2RunsLog(ctx.slug);
      const path = ctx.root === undefined ? resolveRepoPath(rel) : resolve(ctx.root, rel);
      const age = recentlyEnded(await readIterations(path), ctx.now(), DEFAULT_RECENT_WINDOW_MS).get(ctx.ticket);
      return { found: age === undefined ? "none" : `held (ended ${Math.floor(age / 1000)}s ago)`, action: null };
    },
  };

  return [records, dirs, lock, hold];
}
