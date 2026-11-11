/**
 * CLI entrypoint:
 *   node src/core/reset-cli.ts --project <name> [--ticket <KEY>] [--role research|dev|all]
 *                              [--dry-run] [--yes] [--close-remote] [--root <dir>]
 *
 * Deterministic "start fresh" reset of this repo's own v2 pipeline state
 * (runs/v2/<project>.jsonl records, `<role>-*` run dirs under
 * .pipeline/v2/<project>/, and for --ticket the ticket's leftover
 * worktrees). v1 history, in either layout, is never touched. See
 * docs/reset.md.
 *
 * --role (default all) limits the reset to one role's run dirs and the
 * records containing a phase of that role.
 * Without --ticket: the WHOLE project. Requires --yes.
 * --root: the state root (default: this repo's root); tests pass a temp dir.
 *
 * --close-remote (requires --ticket) additionally closes the real Jira
 * ticket, its mirror GitHub Issue, and any PR recorded for the ticket (v2
 * log, else the v1 dev log) -- see src/core/remote-close.ts. Needs
 * credentials, so run it with `--env-file=.env` (`reset-project:remote`).
 * An agent must confirm with the human in chat before a real
 * (non-dry-run) --close-remote, regardless of permission settings -- see
 * docs/reset.md and .claude/skills/reset-project/SKILL.md.
 *
 * The composition root: argv parsing, real config/clients, printing.
 * Its logic (planReset/executeReset/findRecordedPrUrlAcross/...) is unit-tested,
 * and test/core/reset-cli.test.ts drives this file as a subprocess.
 */

import { resolve } from "node:path";
import { loadConfig, resolveProjectConfigPath, repoSlugFromUrl, listAvailableProjects } from "./config.ts";
import { planReset, executeReset, describeResetPlan, describeResetSummary, type ResetRole } from "./reset-project.ts";
import {
  executeRemoteClose,
  describeRemoteClosePlan,
  describeRemoteCloseSummary,
} from "./remote-close.ts";
import { credentialsFromEnv, RealJiraClient } from "./jira-client.ts";
import { RealGitHubClient, realExecGh } from "./github-client.ts";
import type { Config } from "./types.ts";
import { PROJECT_SLUG } from "./paths.ts";
import { findRecordedPrUrlAcross } from "./iteration-log.ts";

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
  const role = getArgValue(argv, "--role") ?? "all";
  const rootArg = getArgValue(argv, "--root");
  const root = rootArg === undefined ? undefined : resolve(rootArg);

  if (role !== "research" && role !== "dev" && role !== "all") {
    console.error(`[reset] --role must be research, dev or all (got "${role}").`);
    process.exitCode = 1;
    return;
  }

  if (closeRemote && !ticketKey) {
    console.error(
      "[reset] --close-remote requires --ticket -- remote-closing every " +
        "ticket in a whole-project reset is out of scope and refused.",
    );
    process.exitCode = 1;
    return;
  }

  // The project config is read from the cwd when it has any, else from
  // this repo's root. The state root is --root, else this repo's root
  // (v2 paths are repo-root-relative, independent of the cwd).
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
  if (!PROJECT_SLUG.test(slug)) {
    console.error(`[reset] project slug ${JSON.stringify(slug)} must match ${PROJECT_SLUG} for the v2 layout.`);
    process.exitCode = 1;
    return;
  }

  const plan = await planReset({ project: slug, ticket: ticketKey, role: role as ResetRole, config, root });

  // The PR lookup reads the logs BEFORE executeReset archives records, and
  // runs under --dry-run too so the preview matches the real run.
  const remotePlan = closeRemote && ticketKey
    ? { ticketKey, prUrl: await findRecordedPrUrlAcross(slug, ticketKey, root) }
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
    plan.recordsToArchive === 0 &&
    plan.runDirsToRemove.length === 0 &&
    plan.sessionLeftoversToRemove.length === 0 &&
    plan.worktreesToRemove.length === 0;
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
    const remoteSummary = await executeRemoteClose(remotePlan, { jiraClient, githubClient, runsLogPath: plan.runsLogPath });
    console.log(describeRemoteCloseSummary(remoteSummary));
  }

  console.log("[reset] done.");
}

main().catch((err) => {
  console.error(`[reset] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
