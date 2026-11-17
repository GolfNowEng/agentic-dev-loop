/**
 * CLI entrypoint:
 *   node src/core/reset-cli.ts --project=<name> [--ticket=<KEY>] [--role=research|dev|all]
 *                              [--include-cross-role] [--ignore-live-worker]
 *                              [--dry-run] [--yes] [--close-remote] [--root=<dir>]
 *
 * Value flags are --name=value only (src/core/flags.ts).
 *
 * Deterministic "start fresh" reset of this repo's own v2 pipeline state
 * (runs/v2/<project>.jsonl records, `<role>-*` run dirs under
 * .pipeline/v2/<project>/, and for --ticket the ticket's leftover
 * worktrees). v1 history, in either layout, is never touched. See
 * docs/reset.md.
 *
 * --role (default all) limits the reset to one role's run dirs and the
 * records containing a phase of that role. A matching record in which the
 * OTHER role landed is refused (kept, listed as REFUSED in the plan) unless
 * --include-cross-role.
 * A real run refuses while a live worker holds a session lock, unless
 * --ignore-live-worker; --dry-run only warns.
 * Without --ticket: the WHOLE project. Requires --yes.
 * --root: the state root (default: this repo's root); tests pass a temp dir.
 *
 * With --ticket: a checklist (src/core/reset/runner.ts). Every area's steps
 * are surveyed read-only into one table; then `Proceed? [y/N]` (only on a
 * TTY; otherwise --yes is required), the approved rows run in area order,
 * and a re-survey of the same steps says whether the ticket is at zero
 * (exit 0) or which rows need you (exit 1). --dry-run prints the table only.
 * Jira/GitHub rows need credentials: both npm scripts load
 * `--env-file-if-exists="${DEVLOOP_ENV_FILE:-.env}"`; without them those rows
 * read "needs you: no credentials" and the local/git/sandbox rows still run.
 *
 * --close-remote (requires --ticket) replaces the Jira reset rows with rows
 * that close the real Jira ticket, its mirror GitHub Issue, and any PR
 * recorded for the ticket (v2 log, else the v1 dev log) -- see
 * src/core/reset/close-steps.ts and src/core/remote-close.ts.
 * An agent must confirm with the human in chat before a real
 * (non-dry-run) --close-remote, regardless of permission settings -- see
 * docs/reset.md and .claude/skills/reset-project/SKILL.md.
 *
 * The composition root: argv parsing, real config/clients, printing.
 * Its logic (planReset/executeReset/findRecordedPrUrlAcross/...) is unit-tested,
 * and test/core/reset-cli.test.ts drives this file as a subprocess.
 */

import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { loadConfig, resolveProjectConfigPath, repoSlugFromUrl, listAvailableProjects } from "./config.ts";
import { planReset, executeReset, describeResetPlan, describeResetSummary, shortenPath, type ResetRole } from "./reset-project.ts";
import { credentialsFromEnv, RealJiraClient } from "./jira-client.ts";
import { RealGitHubClient, realExecGh, realOpenPrHeads } from "./github-client.ts";
import type { Config } from "./types.ts";
import { PROJECT_SLUG } from "./paths.ts";
import { FlagError, parseFlags } from "./flags.ts";
import { selectSandbox } from "../sandbox/select.ts";
import type { ResetCtx } from "./reset/context.ts";
import type { ResetStep, Survey } from "./reset/step.ts";
import { runChecklist, type RunnerIO } from "./reset/runner.ts";
import { sandboxSteps } from "./reset/sandbox-steps.ts";
import { gitSteps } from "./reset/git-steps.ts";
import { localSteps } from "./reset/local-steps.ts";
import { jiraSteps } from "./reset/jira-steps.ts";
import { runWindows } from "./reset/run-windows.ts";
import { githubSteps } from "./reset/github-steps.ts";
import { closeSteps } from "./reset/close-steps.ts";

const execFileP = promisify(execFile);

const SPEC = {
  values: ["--project", "--ticket", "--role", "--root"],
  bools: ["--dry-run", "--yes", "--close-remote", "--include-cross-role", "--ignore-live-worker"],
} as const;

async function main(): Promise<void> {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2), SPEC, "reset");
  } catch (err) {
    if (!(err instanceof FlagError)) throw err;
    console.error(`[${err.message}`.replace(/^\[reset: /, "[reset] "));
    process.exitCode = 1;
    return;
  }
  const { values, bools } = flags;
  const projectName = values["--project"];
  const ticketKey = values["--ticket"];
  const dryRun = bools.has("--dry-run");
  const skipConfirm = bools.has("--yes");
  const closeRemote = bools.has("--close-remote");
  const role = values["--role"] ?? "all";
  const includeCrossRole = bools.has("--include-cross-role");
  const ignoreLiveWorker = bools.has("--ignore-live-worker");
  const rootArg = values["--root"];
  const root = rootArg === undefined ? undefined : resolve(rootArg);

  if (role !== "research" && role !== "dev" && role !== "all") {
    console.error(`[reset] --role must be research, dev or all (got "${role}").`);
    process.exitCode = 1;
    return;
  }

  if (closeRemote && !ticketKey) {
    console.error(
      "[reset] --close-remote requires --ticket=<KEY> -- remote-closing every " +
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

  if (ticketKey) {
    console.log(`[reset] project: ${projectName} (slug: ${slug}), ticket: ${ticketKey}`);
    process.exitCode = await resetTicket({
      project: projectName!, slug, ticket: ticketKey, role: role as ResetRole, config, root,
      closeRemote, includeCrossRole, ignoreLiveWorker, dryRun, yes: skipConfirm,
    });
    return;
  }

  // Whole project (no --ticket): today's plan / --yes / execute path.
  const plan = await planReset({
    project: slug,
    ticket: ticketKey,
    role: role as ResetRole,
    config,
    root,
    includeCrossRole,
    ignoreLiveWorker,
  });

  console.log(`[reset] project: ${projectName} (slug: ${slug}), WHOLE PROJECT`);
  console.log(describeResetPlan(plan));

  if (dryRun) {
    console.log("[reset] --dry-run: nothing deleted or closed.");
    return;
  }

  if (!skipConfirm) {
    console.error(
      "[reset] a whole-project reset (no --ticket=<KEY>) requires --yes to confirm -- " +
        "this deletes EVERY ticket's history for this project, not just one.",
    );
    process.exitCode = 1;
    return;
  }

  if (plan.liveWorkerLocks.length > 0 && !ignoreLiveWorker) {
    console.error(
      `[reset] refusing: a live worker holds ${plan.liveWorkerLocks.join(", ")}. Stop it first, or pass --ignore-live-worker.`,
    );
    process.exitCode = 1;
    return;
  }

  const summary = await executeReset(plan);
  console.log(describeResetSummary(summary));
  console.log("[reset] done.");
}

interface TicketResetOpts {
  project: string;
  slug: string;
  ticket: string;
  role: ResetRole;
  config: Config | null;
  root: string | undefined;
  closeRemote: boolean;
  includeCrossRole: boolean;
  ignoreLiveWorker: boolean;
  dryRun: boolean;
  yes: boolean;
}

/** One line from stdin when it is a terminal; null otherwise (the runner then requires --yes). */
const terminalIO: RunnerIO = {
  print: (s) => console.log(s),
  async ask(q) {
    if (!process.stdin.isTTY) return null;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  },
};

/** A step that only reports why its area can't be surveyed (e.g. an invalid sandbox config). */
const blockedStep = (area: ResetStep["area"], name: string, why: string): ResetStep => ({
  area,
  name,
  survey: async (): Promise<Survey> => ({ found: "-", action: null, needsYou: why }),
});

async function resetTicket(o: TicketResetOpts): Promise<number> {
  // Real clients only when credentials load; otherwise every Jira/GitHub row
  // says "needs you: no credentials" and the local, git and sandbox rows run.
  let jira: ResetCtx["jira"] = null;
  let github: ResetCtx["github"] = null;
  let openPrHeads: ResetCtx["openPrHeads"] = null;
  if (o.config) {
    let credentials = null;
    try {
      credentials = credentialsFromEnv();
    } catch {
      // No credentials: rows report it.
    }
    if (credentials) {
      jira = new RealJiraClient(credentials, o.config);
      github = new RealGitHubClient(o.config.github, realExecGh());
      openPrHeads = realOpenPrHeads(o.config.github.repo);
    }
  }

  const extra: ResetStep[] = [];
  let sandbox: ResetCtx["sandbox"] = null;
  let sandboxConfig: unknown = undefined;
  if (o.config) {
    try {
      const sel = selectSandbox(o.config, undefined);
      sandbox = sel.adapter;
      sandboxConfig = sel.config;
    } catch (e) {
      extra.push(blockedStep("sandbox", "leftover sandboxes", (e instanceof Error ? e.message : String(e)).split("\n")[0]!));
    }
  }

  const ctx: ResetCtx = {
    project: o.project,
    slug: o.slug,
    ticket: o.ticket,
    role: o.role,
    config: o.config,
    root: o.root,
    jira,
    github,
    openPrHeads,
    git: async (args, cwd) => (await execFileP("git", args, { cwd, encoding: "utf8" })).stdout,
    sandbox,
    sandboxConfig,
    now: () => new Date(),
    closeRemote: o.closeRemote,
    includeCrossRole: o.includeCrossRole,
  };

  const livePlan = () =>
    planReset({ project: o.slug, ticket: o.ticket, role: o.role, config: o.config, root: o.root, skipWorktrees: true, ignoreLiveWorker: true });
  const liveWorker: ResetStep = {
    area: "local",
    name: "live worker",
    async survey(): Promise<Survey> {
      const locks = (await livePlan()).liveWorkerLocks.map((l) => basename(l));
      if (locks.length === 0) return { found: "none", action: null };
      const found = locks.map((l) => `${l} (holder alive)`).join(", ");
      return o.ignoreLiveWorker ? { found, action: null } : { found, action: null, needsYou: `a live worker holds ${locks.join(", ")}` };
    },
  };

  let steps: ResetStep[];
  try {
    // Built once: the verify pass re-surveys these same instances.
    steps = [
      ...extra,
      ...sandboxSteps(ctx),
      ...gitSteps(ctx),
      liveWorker,
      ...localSteps(ctx),
      ...(o.closeRemote ? closeSteps(ctx) : jiraSteps(ctx, () => runWindows(ctx))),
      ...githubSteps(ctx),
    ];
  } catch (e) {
    console.error(`[reset] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  return runChecklist(
    steps,
    {
      title: `Reset ${o.ticket} (role: ${o.role})`,
      ticket: o.ticket,
      dryRun: o.dryRun,
      yes: o.yes,
      async preExecuteCheck() {
        if (o.ignoreLiveWorker) return null;
        const locks = (await livePlan()).liveWorkerLocks;
        if (locks.length === 0) return null;
        return `[reset] refusing: a live worker holds ${locks.map(shortenPath).join(", ")}. Stop it first, or pass --ignore-live-worker.`;
      },
    },
    terminalIO,
  );
}

main().catch((err) => {
  console.error(`[reset] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
