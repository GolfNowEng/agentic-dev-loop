/**
 * CLI entrypoint: `node src/reset-cli.ts --project <name> [--ticket <KEY>] [--dry-run] [--yes]`.
 *
 * Deterministic "start fresh" reset for this repo's own local, gitignored
 * pipeline state -- runs/<project>.jsonl lines, .pipeline/<project>/ run
 * dirs and raw-usage files, and (when --ticket is given and
 * targetRepo.path is set) this repo's own leftover worktrees under that
 * path. Never touches Jira, GitHub, or the target repo's git history --
 * see docs/reset.md for exactly what is and isn't in scope, and why.
 *
 * With --ticket <KEY>: scoped to just that ticket within the project.
 * Without --ticket: wipes the WHOLE project's runs.jsonl and .pipeline/
 * directory -- every ticket, not just one. Requires --yes (or an
 * interactive "yes" confirmation) since this is the harder-to-undo path.
 *
 * This file is deliberately the untested composition root, same rationale
 * as main.ts -- every piece of logic it calls (planReset/executeReset/
 * describeResetPlan) already has full vitest coverage against a temp
 * filesystem; this is just argv parsing, loading the real config, and
 * printing the plan.
 */

import { loadConfig, resolveProjectConfigPath, repoSlugFromUrl } from "./config.ts";
import { planReset, executeReset, describeResetPlan } from "./reset-project.ts";
import type { Config } from "./types.ts";

function getArgValue(argv: string[], name: string): string | undefined {
  const eqPrefix = `${name}=`;
  const eqArg = argv.find((arg) => arg.startsWith(eqPrefix));
  if (eqArg !== undefined) return eqArg.slice(eqPrefix.length);
  const index = argv.indexOf(name);
  return index !== -1 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const projectName = getArgValue(argv, "--project");
  const ticketKey = getArgValue(argv, "--ticket");
  const dryRun = argv.includes("--dry-run");
  const skipConfirm = argv.includes("--yes");

  const configPath = await resolveProjectConfigPath(projectName);
  let config: Config | null = null;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    // A malformed/placeholder-only config must never block a reset -- the
    // whole point of this tool is to recover a stuck local state, which
    // can include a project whose config is mid-edit. Fall back to no
    // worktree scan (planReset accepts config: null for exactly this).
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reset] warning: could not load ${configPath} (${message}); continuing without a targetRepo.path worktree scan.`);
  }

  const slug = config ? repoSlugFromUrl(config.targetRepo.url) : projectName!;
  const repoRoot = process.cwd();

  const plan = await planReset(repoRoot, slug, ticketKey, config);

  console.log(`[reset] project: ${projectName} (slug: ${slug})${ticketKey ? `, ticket: ${ticketKey}` : ", WHOLE PROJECT"}`);
  console.log(describeResetPlan(plan));

  if (dryRun) {
    console.log("[reset] --dry-run: nothing deleted.");
    return;
  }

  const nothingToDo =
    plan.runsLogLinesToRemove === 0 &&
    plan.runDirsToRemove.length === 0 &&
    plan.rawUsageFilesToRemove.length === 0 &&
    plan.worktreesToRemove.length === 0 &&
    !(plan.wholeProject && plan.runsLogPath);
  if (nothingToDo && !plan.wholeProject) {
    console.log("[reset] nothing matched -- nothing to delete.");
    return;
  }

  if (plan.wholeProject && !skipConfirm) {
    console.error(
      "[reset] a whole-project reset (no --ticket) requires --yes to confirm -- " +
        "this deletes EVERY ticket's history for this project, not just one.",
    );
    process.exitCode = 1;
    return;
  }

  await executeReset(plan);
  console.log("[reset] done.");
}

main().catch((err) => {
  console.error(`[reset] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
