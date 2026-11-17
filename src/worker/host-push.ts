import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReadyToPush } from "../core/types.ts";
import type { SpawnClaudeOpts, SpawnClaudeResult } from "../core/spawn-claude.ts";
import { isPipelineWorktree } from "../core/paths.ts";
import { signUnpushed, type GitFn } from "./host-sign.ts";

export const HOST_PUSH_MODEL = "haiku";
export const HOST_PUSH_TOOLS = "Bash,Read";

export interface HostPushDeps {
  repoDir: string; repoRoot: string; githubRepo: string; defaultBranch: string;
  git: GitFn;
  spawn: (o: SpawnClaudeOpts) => Promise<SpawnClaudeResult>;
  run: (cmd: string, args: string[], cwd: string) => Promise<string>;
  findOpenPrUrlForBranch: (branch: string) => Promise<string | null>;
  pushBranchSkill: string;
  timeoutMin: number; maxBudgetUsd: number; stream: boolean; env: NodeJS.ProcessEnv;
  /** Absolute path for the spawn's raw usage file. */
  usagePath: string;
  log: (m: string) => void;
  sign?: typeof signUnpushed;
}

export type HostPushResult =
  | { ok: true; pr: string; branch: string; signed: number; oldTip: string; newTip: string; costUsd: number }
  | { ok: false; detail: string; costUsd: number };

/** "…/dev-20261117T090121Z" -> "20261117T090121Z": the last path segment after its first "-". */
export function runIdFromRunDir(runDir: string): string {
  const seg = runDir.replace(/\/+$/, "").split("/").pop() ?? "";
  const i = seg.indexOf("-");
  return i < 0 ? seg : seg.slice(i + 1);
}

export function hostPushPrompt(a: { skill: string; worktree: string; branch: string; title: string; body: string }): string {
  return [
    `Read ${a.skill} with the Read tool and follow it exactly, in its content-supplied mode, with --no-jira.`,
    `Work only in ${a.worktree}: run every command as \`direnv exec ${a.worktree} <command>\` from that directory (\`cd ${a.worktree} && direnv exec ${a.worktree} git push -u origin ${a.branch}\`).`,
    `The branch is ${a.branch}; its commits are already signed; do not commit, amend, rebase or reset.`,
    `Never pass --no-verify or skip a hook. If the push or the PR fails, stop and print the error.`,
    `--title "${a.title}"`,
    `Body:`,
    a.body,
  ].join("\n");
}

const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n").map((l) => l.trim()).find(Boolean) ?? "unknown error";

function resultText(stdout: string): string {
  try {
    const r = (JSON.parse(stdout) as { result?: unknown }).result;
    if (typeof r === "string") return r;
  } catch { /* fall through */ }
  return stdout;
}

export async function hostPush(ticketKey: string, runId: string, ready: ReadyToPush, d: HostPushDeps): Promise<HostPushResult> {
  const name = `${ticketKey}-${runId}-push`;
  const wt = join(d.repoDir, ".claude", "worktrees", name);
  let cost = 0;
  const fail = (detail: string): HostPushResult => ({ ok: false, detail, costUsd: cost });
  const wtGit: GitFn = (args, cwd) => d.run("direnv", ["exec", wt, "git", ...args], cwd);
  let added = false;

  try {
    try { await d.git(["fetch", "origin"], d.repoDir); }
    catch (e) { return fail(`git fetch origin failed: ${firstLine(e)}`); }

    if (existsSync(wt)) {
      if (!isPipelineWorktree(ticketKey, name)) return fail(`refusing to remove non-pipeline worktree ${wt}`);
      // never forced on any path but our own -push worktree (isPipelineWorktree above)
      try { await d.git(["worktree", "remove", "--force", wt], d.repoDir); } // never elsewhere
      catch (e) { return fail(`could not clear stale worktree ${wt}: ${firstLine(e)}`); }
    }
    try { await d.git(["worktree", "add", wt, ready.branch], d.repoDir); added = true; }
    catch (e) { return fail(`git worktree add failed for branch ${ready.branch}: ${firstLine(e)}`); }

    try { await d.run("direnv", ["exec", wt, "npm", "ci"], wt); }
    catch (e) { return fail(`npm ci failed in ${wt}: ${firstLine(e)}`); }

    const signed = await (d.sign ?? signUnpushed)({ worktree: wt, branch: ready.branch, ticketKey, defaultBranch: d.defaultBranch, git: wtGit });
    if (!signed.ok) return fail(`signing failed: ${signed.reason}`);

    if (!existsSync(d.pushBranchSkill)) return fail(`push-branch skill not found at ${d.pushBranchSkill}`);

    const res = await d.spawn({
      prompt: hostPushPrompt({ skill: d.pushBranchSkill, worktree: wt, branch: ready.branch, title: ready.pr_title, body: ready.pr_body }),
      model: HOST_PUSH_MODEL,
      allowedTools: HOST_PUSH_TOOLS,
      addDir: d.repoDir,
      timeoutMin: d.timeoutMin,
      maxBudgetUsd: d.maxBudgetUsd,
      stream: d.stream,
      ticketKey,
      rawUsagePath: d.usagePath,
      env: d.env,
      cwd: d.repoRoot,
      logPrefix: "host-push",
    });
    cost = res.usage?.costUsd ?? 0;

    let branch: string;
    try { branch = (await d.git(["rev-parse", "--abbrev-ref", "HEAD"], wt)).trim(); }
    catch (e) { return fail(`could not read branch in ${wt}: ${firstLine(e)}`); }

    const pr = await d.findOpenPrUrlForBranch(branch);
    if (!pr) return fail(`push-branch did not leave an open PR for ${branch}: ${resultText(res.stdout).slice(0, 300)}`);
    return { ok: true, pr, branch, signed: signed.signed, oldTip: signed.oldTip, newTip: signed.newTip, costUsd: cost };
  } catch (e) {
    return fail(`host push failed: ${firstLine(e)}`);
  } finally {
    if (added) {
      try { await d.git(["worktree", "remove", wt], d.repoDir); }
      catch (e) { d.log(`host-push: could not remove worktree ${wt}: ${firstLine(e)}`); }
    }
  }
}
