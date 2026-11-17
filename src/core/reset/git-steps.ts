// Git reset steps: the ticket's worktrees, its local branches, and a read-only
// list of its pushed branches and open PRs. Only `<TICKET>-*` names are ever
// considered (exact prefix, so TARS-1 never matches TARS-10-...), and only
// worktrees the pipeline makes (isPipelineWorktree) are ever removed: any
// other `<TICKET>-*` worktree is a person's own and is only reported. A local
// branch is deleted only when it is not on origin, has no open PR, is 0 ahead
// of origin/<defaultBranch> and is not checked out in the repo; every one of
// those is re-checked right before `git branch -D`. Pushed branches and PRs
// are never touched here.
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isPipelineWorktree, resolveRepoPath, TICKET_KEY, UnsafePathError, v2CloneDir } from "../paths.ts";
import type { ResetCtx } from "./context.ts";
import type { ResetStep, Survey } from "./step.ts";

const NO_CONFIG: Survey = { found: "-", action: null, needsYou: "no project config" };
const DEV_ONLY: Survey = { found: "-", action: null };

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].trim();

/** The target repo, resolved the same way planReset resolves the worktree base. */
function repoDir(ctx: ResetCtx): string | null {
  if (!ctx.config) return null;
  if (ctx.config.targetRepo.path) return resolve(ctx.config.targetRepo.path);
  const rel = v2CloneDir(ctx.slug);
  return ctx.root === undefined ? resolveRepoPath(rel) : resolve(ctx.root, rel);
}

function assertUnder(path: string, base: string): void {
  if (!resolve(path).startsWith(resolve(base) + sep)) {
    throw new UnsafePathError(`refusing to remove ${JSON.stringify(path)}: worktree outside ${base}`);
  }
}

/** `refs/heads/<b>` names from `git ls-remote --heads origin` output. */
function remoteHeads(out: string): Set<string> {
  const heads = new Set<string>();
  for (const line of out.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (ref?.startsWith("refs/heads/")) heads.add(ref.slice("refs/heads/".length));
  }
  return heads;
}

export function gitSteps(ctx: ResetCtx): ResetStep[] {
  if (!TICKET_KEY.test(ctx.ticket)) throw new UnsafePathError(`ticket ${JSON.stringify(ctx.ticket)} must match ${TICKET_KEY}`);
  const prefix = `${ctx.ticket}-`;
  const ours = (name: string) => name.startsWith(prefix);
  const git = (args: string[], cwd: string) => ctx.git(args, cwd);

  const worktrees: ResetStep = {
    area: "git",
    name: "worktrees",
    async survey(): Promise<Survey> {
      const repo = repoDir(ctx);
      if (repo === null) return NO_CONFIG;
      const lexical = join(repo, ".claude", "worktrees");
      // git reports real paths; compare against the real worktrees dir.
      const wtDir = await realpath(lexical).catch(() => null);
      if (wtDir === null) return { found: "none", action: null };
      const pipelineMade = (name: string) => isPipelineWorktree(ctx.ticket, name);
      const inScope = (name: string) => pipelineMade(name) && (ctx.role === "all" || (ctx.role === "research") === name.endsWith("-ground"));
      // `<TICKET>-*` dirs the pipeline never makes: a person's own, never removed.
      const notOurs = (await readdir(wtDir).catch(() => [] as string[])).filter((n) => ours(n) && !pipelineMade(n)).sort();
      const notOursDetails = notOurs.map((n) => `needs you: ${n} is not a pipeline worktree`);

      let listed = "";
      try {
        listed = await git(["worktree", "list", "--porcelain"], repo);
      } catch {
        // Not a git repo (or no git): nothing registered; leftover dirs are still in scope.
      }
      const registered = listed
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => resolve(l.slice("worktree ".length).trim()))
        .filter((p) => dirname(p) === wtDir && inScope(basename(p)));
      const regNames = new Set(registered.map((p) => basename(p)));
      const leftovers: string[] = [];
      for (const name of await readdir(wtDir).catch(() => [] as string[])) {
        if (regNames.has(name) || !inScope(name)) continue;
        const st = await lstat(join(wtDir, name)).catch(() => null);
        if (st?.isDirectory()) leftovers.push(join(wtDir, name));
      }
      const all = [...registered, ...leftovers].sort((a, b) => basename(a).localeCompare(basename(b)));
      if (all.length === 0) {
        if (notOurs.length === 0) return { found: "none", action: null };
        return { found: notOurs.join(", "), action: null, needsYou: `${notOurs.join(", ")}: not a pipeline worktree`, details: notOursDetails };
      }

      const run = async (): Promise<void> => {
        for (const p of all) assertUnder(p, wtDir);
        for (const p of registered) {
          const present = await lstat(p).then(() => true, () => false);
          // A missing dir is left to prune. This flag only discards the worktree's uncommitted files.
          if (present) await git(["worktree", "remove", "--force", p], repo); // never a push

        }
        for (const p of leftovers) await rm(p, { recursive: true, force: true });
        try {
          await git(["worktree", "prune"], repo);
        } catch (e) {
          if (registered.length > 0) throw e; // no registered entries: no git repo to prune
        }
      };
      const names = all.map((p) => basename(p));
      return {
        found: names.join(", ") + (notOurs.length > 0 ? ` (+${notOurs.length} not pipeline)` : ""),
        action: `remove ${all.length} + prune`,
        details: [...names.map((n) => `remove ${n}`), ...notOursDetails],
        run,
      };
    },
  };

  const localBranches: ResetStep = {
    area: "git",
    name: "local branches",
    async survey(): Promise<Survey> {
      if (ctx.role === "research") return DEV_ONLY;
      const repo = repoDir(ctx);
      if (repo === null || !ctx.config) return NO_CONFIG;
      const base = ctx.config.targetRepo.defaultBranch;
      const names = (await git(["for-each-ref", `refs/heads/${prefix}*`, "--format=%(refname:short)"], repo))
        .split("\n").map((s) => s.trim()).filter(ours);
      if (names.length === 0) return { found: "none", action: null };

      let onOrigin: Set<string>;
      let prHeads: Set<string>;
      try {
        if (ctx.openPrHeads === null) throw new Error("no GitHub credentials");
        await git(["fetch", "--quiet", "origin", base], repo);
        onOrigin = remoteHeads(await git(["ls-remote", "--heads", "origin"], repo));
        prHeads = new Set((await ctx.openPrHeads(ctx.ticket)).map((p) => p.head));
      } catch (e) {
        return { found: names.join(", "), action: null, needsYou: `remote check failed: ${firstLine(e)}` };
      }
      const head = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo).catch(() => "")).trim();
      const ahead = async (b: string) => Number((await git(["rev-list", "--count", `origin/${base}..refs/heads/${b}`], repo)).trim());

      const found: string[] = [];
      const deletable: string[] = [];
      const blocked: string[] = [];
      for (const b of names) {
        if (onOrigin.has(b)) { found.push(`${b} (on origin)`); continue; }
        if (prHeads.has(b)) { found.push(`${b} (open PR)`); continue; }
        if (b === head) { found.push(`${b} (checked out)`); blocked.push(`${b} is checked out in ${basename(repo)}`); continue; }
        const n = await ahead(b);
        if (n === 0) { found.push(`${b} (0 ahead)`); deletable.push(b); continue; }
        found.push(`${b} (${n} unpushed)`);
        blocked.push(`${b} has ${n} unpushed commit(s)`);
      }

      if (deletable.length === 0) {
        return blocked.length > 0 ? { found: found.join(", "), action: null, needsYou: blocked.join("; ") } : { found: found.join(", "), action: null };
      }
      // Every branch, one per line: the person approves the full list, not the truncated Found cell.
      const listing = found.map((f) => (deletable.some((b) => f === `${b} (0 ahead)`) ? `delete ${f}` : `keep ${f}`));
      const run = async (): Promise<void> => {
        const skipped: string[] = [];
        await git(["fetch", "--quiet", "origin", base], repo);
        const remote = remoteHeads(await git(["ls-remote", "--heads", "origin"], repo));
        const prs = new Set((await ctx.openPrHeads!(ctx.ticket)).map((p) => p.head));
        const nowHead = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo).catch(() => "")).trim();
        for (const b of deletable) {
          const why = await (async (): Promise<string | null> => {
            const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], repo).then(() => true, () => false);
            if (!exists) return "no longer exists";
            if (remote.has(b)) return "now on origin";
            if (prs.has(b)) return "now has an open PR";
            if (b === nowHead) return `checked out in ${basename(repo)}`;
            const n = await ahead(b);
            return n === 0 ? null : `now ${n} ahead`;
          })();
          if (why !== null) { skipped.push(`${b} (${why})`); continue; }
          // e.g. checked out in a worktree outside .claude/worktrees: keep going, report it.
          await git(["branch", "-D", b], repo).catch((e) => skipped.push(`${b} (${firstLine(e)})`));
        }
        if (skipped.length > 0) throw new Error(`kept on re-check: ${skipped.join(", ")}`);
      };
      return {
        found: found.join(", "),
        action: `delete ${deletable.length}`,
        run,
        details: [...listing, ...blocked.map((w) => `needs you: ${w}`)],
      };
    },
  };

  const pushed: ResetStep = {
    area: "git",
    name: "pushed branches / PRs",
    async survey(): Promise<Survey> {
      if (ctx.role === "research") return DEV_ONLY;
      const repo = repoDir(ctx);
      if (repo === null) return NO_CONFIG;
      try {
        if (ctx.openPrHeads === null) throw new Error("no GitHub credentials");
        const heads = [...remoteHeads(await git(["ls-remote", "--heads", "origin"], repo))].filter(ours).sort();
        const prs = (await ctx.openPrHeads(ctx.ticket)).filter((p) => ours(p.head));
        const items = [...heads.map((b) => `${b} on origin`), ...prs.map((p) => `PR ${p.url}`)];
        return { found: items.length === 0 ? "none" : items.join(", "), action: null };
      } catch (e) {
        return { found: "-", action: null, needsYou: `remote check failed: ${firstLine(e)}` };
      }
    },
  };

  return [worktrees, localBranches, pushed];
}
