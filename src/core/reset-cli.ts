/**
 * CLI entrypoint:
 *   node src/reset-cli.ts --project <name> [--ticket <KEY>] [--dry-run] [--yes] [--close-remote]
 *
 * Deterministic "start fresh" reset for this repo's own local, gitignored
 * pipeline state -- runs/<project>.jsonl lines, .pipeline/<project>/ run
 * dirs and raw-usage files, and (when --ticket is given and
 * targetRepo.path is set) this repo's own leftover worktrees under that
 * path. See docs/reset.md for exactly what is and isn't in scope, and why.
 *
 * With --ticket <KEY>: scoped to just that ticket within the project.
 * Without --ticket: wipes the WHOLE project's runs.jsonl and .pipeline/
 * directory -- every ticket, not just one. Requires --yes (or an
 * interactive "yes" confirmation) since this is the harder-to-undo path.
 *
 * --close-remote (requires --ticket -- rejected for a whole-project
 * reset, see below) additionally closes the real Jira ticket, its mirror
 * GitHub Issue, and any open PR -- see src/remote-close.ts. Needs real
 * Jira/GitHub credentials, so it must be run with `--env-file=.env` (the
 * `reset-project:remote` npm script does this; the default
 * `reset-project` script deliberately does not, so a purely local-only
 * reset never requires .env to exist at all). An agent invoking this flag
 * for a real (non-dry-run) run must always confirm with the human in
 * chat first, regardless of Claude Code permission settings -- see
 * docs/reset.md and .claude/skills/reset-project/SKILL.md.
 *
 * This file is deliberately the untested composition root, same rationale
 * as main.ts -- every piece of logic it calls (planReset/executeReset/
 * describeResetPlan/planRemoteClose/executeRemoteClose/describe*) already
 * has full vitest coverage against a temp filesystem or injected mock
 * clients; this is just argv parsing, loading real config/clients, and
 * printing plans/summaries.
 */

import { join, resolve } from "node:path";
import { loadConfig, resolveProjectConfigPath, repoSlugFromUrl, listAvailableProjects } from "./config.ts";
import { planReset, executeReset, describeResetPlan, describeResetSummary } from "./reset-project.ts";
import {
  planRemoteClose,
  executeRemoteClose,
  describeRemoteClosePlan,
  describeRemoteCloseSummary,
} from "./remote-close.ts";
import { credentialsFromEnv, RealJiraClient } from "./jira-client.ts";
import { RealGitHubClient, realExecGh } from "./github-client.ts";
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
  const closeRemote = argv.includes("--close-remote");

  if (closeRemote && !ticketKey) {
    console.error(
      "[reset] --close-remote requires --ticket -- remote-closing every " +
        "ticket in a whole-project reset is out of scope and refused.",
    );
    process.exitCode = 1;
    return;
  }

  // The cwd is the state root (runs/, .pipeline/). The project config is
  // read from the cwd when it has any, else from this repo's root: since
  // 2.0.0, research-loop/ (the research phase's v1 state root) has no
  // config copies of its own.
  const configDir = (await listAvailableProjects(".")).length > 0 ? "." : resolve(import.meta.dirname, "../..");
  const configPath = await resolveProjectConfigPath(projectName, configDir);
  let config: Config | null = null;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    // A malformed/placeholder-only config must never block a LOCAL-ONLY
    // reset -- the whole point of this tool is to recover a stuck local
    // state, which can include a project whose config is mid-edit.
    // Fall back to no worktree scan (planReset accepts config: null for
    // exactly this). --close-remote, however, genuinely needs a real
    // config (github.repo at minimum) -- checked again below, right
    // before it would try to construct real clients.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reset] warning: could not load ${configPath} (${message}); continuing without a targetRepo.path worktree scan.`);
  }

  const slug = config ? repoSlugFromUrl(config.targetRepo.url) : projectName!;
  const repoRoot = process.cwd();

  const plan = await planReset(repoRoot, slug, ticketKey, config);

  // planRemoteClose reads runs.jsonl to recover the ticket's open PR URL
  // -- this MUST happen before executeReset below, which archives/trims
  // that same file. Doing it here (even under --dry-run, where nothing
  // is executed) keeps the dry-run preview honest about what a real run
  // would actually find.
  const remotePlan = closeRemote && ticketKey
    ? await planRemoteClose(ticketKey, plan.runsLogPath ?? join(repoRoot, "runs", `${slug}.jsonl`))
    : null;

  console.log(`[reset] project: ${projectName} (slug: ${slug})${ticketKey ? `, ticket: ${ticketKey}` : ", WHOLE PROJECT"}`);
  console.log(describeResetPlan(plan));
  if (remotePlan) {
    console.log(describeRemoteClosePlan(remotePlan));
  }

  if (dryRun) {
    console.log("[reset] --dry-run: nothing deleted or closed.");
    return;
  }

  const nothingToDo =
    plan.runsLogLinesToRemove === 0 &&
    plan.runDirsToRemove.length === 0 &&
    plan.rawUsageFilesToRemove.length === 0 &&
    plan.worktreesToRemove.length === 0 &&
    !(plan.wholeProject && plan.runsLogPath);
  if (nothingToDo && !plan.wholeProject && !closeRemote) {
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

  const summary = await executeReset(plan);
  console.log(describeResetSummary(summary));

  if (closeRemote && remotePlan) {
    // Real Jira/GitHub clients are constructed ONLY here, ONLY when
    // --close-remote was actually passed -- a local-only reset (the
    // default, and the common case) must never require real credentials
    // or a fully-filled-in project config to exist at all.
    if (!config) {
      console.error(
        `[reset] --close-remote requires a valid project config (could not load ${configPath} earlier) -- local reset completed, but remote closing was skipped.`,
      );
      process.exitCode = 1;
      return;
    }
    const credentials = credentialsFromEnv();
    const jiraClient = new RealJiraClient(credentials, config);
    const githubClient = new RealGitHubClient(config.github, realExecGh());
    const remoteSummary = await executeRemoteClose(remotePlan, {
      jiraClient,
      githubClient,
      runsLogPath: plan.runsLogPath ?? join(repoRoot, "runs", `${slug}.jsonl`),
    });
    console.log(describeRemoteCloseSummary(remoteSummary));
  }

  console.log("[reset] done.");
}

main().catch((err) => {
  console.error(`[reset] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
