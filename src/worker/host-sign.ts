import { execFile } from "node:child_process";
import { containsTicketToken } from "../core/github-client.ts";

export type GitFn = (args: string[], cwd: string) => Promise<string>; // rejects with stderr on non-zero
export interface SignArgs { worktree: string; branch: string; ticketKey: string; defaultBranch: string; git: GitFn }
export type SignResult =
  | { ok: true; base: string; oldTip: string; newTip: string; signed: number }
  | { ok: false; reason: string; restored: boolean };

export function realGit(env?: NodeJS.ProcessEnv, timeoutMs?: number): GitFn {
  const merged = { ...(env ?? process.env), GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile("git", args, { cwd, env: merged, maxBuffer: 64 * 1024 * 1024, ...(timeoutMs ? { timeout: timeoutMs } : {}) }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr).trim() || err.message));
        else resolve(String(stdout));
      });
    });
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);
const firstLine = (e: unknown): string => lines(e instanceof Error ? e.message : String(e))[0] ?? "unknown error";

export async function signUnpushed(a: SignArgs): Promise<SignResult> {
  const { worktree: wt, branch, ticketKey, defaultBranch } = a;
  const run = async (...args: string[]): Promise<string> => (await a.git(args, wt)).trim();
  const fail = (reason: string, restored = false): SignResult => ({ ok: false, reason, restored });

  try {
    if ((await run("status", "--porcelain")) !== "") return fail(`worktree ${wt} has uncommitted changes`);
    const head = await run("rev-parse", "--abbrev-ref", "HEAD");
    if (head !== branch) return fail(`HEAD is ${head}, expected ${branch}`);
    if (!containsTicketToken(branch, ticketKey)) return fail(`branch ${branch} does not name ${ticketKey}`);

    const pushed = (await run("ls-remote", "--heads", "origin", branch)) !== "";
    let base: string;
    if (pushed) {
      // Pushed: only the commits on top of origin/<branch>, and only if HEAD still descends from it.
      base = await run("rev-parse", "--verify", `origin/${branch}^{commit}`);
      try { await run("merge-base", "--is-ancestor", base, "HEAD"); }
      catch { return fail(`origin/${branch} is not an ancestor of HEAD (diverged); refusing to rewrite`); }
    } else {
      // Unpushed: keep the fork point; never replay onto a default branch that moved since.
      await run("rev-parse", "--verify", `origin/${defaultBranch}^{commit}`);
      base = await run("merge-base", "HEAD", `origin/${defaultBranch}`);
    }

    const shas = lines(await run("rev-list", `${base}..HEAD`));
    if (shas.length === 0) {
      // Already pushed and nothing new on top: those commits went through this
      // signing before (a retry after the PR step failed). Nothing to rewrite.
      if (pushed) return { ok: true, base, oldTip: base, newTip: base, signed: 0 };
      return fail(`nothing to sign on ${branch}`);
    }
    const merges = lines(await run("rev-list", "--merges", `${base}..HEAD`));
    if (merges.length > 0) return fail(`${merges[0]} is a merge commit; refusing to rewrite`);
    const unpushed = new Set(lines(await run("rev-list", "HEAD", "--not", "--remotes=origin")));
    const onOrigin = shas.find((sha) => !unpushed.has(sha));
    if (onOrigin) return fail(`${onOrigin} is already on origin; refusing to rewrite pushed history`);

    const oldTip = await run("rev-parse", "HEAD");
    const oldTree = await run("rev-parse", "HEAD^{tree}");
    const restore = async (): Promise<void> => { await run("reset", "--hard", oldTip); };

    try {
      await run("rebase", "--exec", "git commit --amend --no-edit --reset-author -S", base);
    } catch (e) {
      await run("rebase", "--abort").catch(() => undefined);
      await restore();
      return fail(`signing failed: ${firstLine(e)}`, true);
    }

    if ((await run("rev-parse", "HEAD^{tree}")) !== oldTree) {
      await restore();
      return fail("tree changed after signing", true);
    }
    const sigs = lines(await run("log", "--format=%H %G?", `${base}..HEAD`));
    for (const l of sigs) {
      const [sha, c] = l.split(" ");
      if (c !== "G") {
        await restore();
        return fail(`${sha} signature is ${c}, expected G`, true);
      }
    }
    return { ok: true, base, oldTip, newTip: await run("rev-parse", "HEAD"), signed: shas.length };
  } catch (e) {
    return fail(firstLine(e));
  }
}
