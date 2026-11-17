import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSteps } from "../../../src/core/reset/git-steps.ts";
import type { ResetCtx } from "../../../src/core/reset/context.ts";
import type { Survey } from "../../../src/core/reset/step.ts";
import type { Config } from "../../../src/core/types.ts";

// Isolate from the developer's global git config (hooks, gpg, templates).
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const BASE = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const g = (cwd: string, ...args: string[]): string => execFileSync("git", [...BASE, ...args], { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((ok, fail) => execFile("git", args, { cwd, env: ENV, encoding: "utf8" }, (e, out, err) => (e ? fail(new Error(err.trim() || e.message)) : ok(out))));
const exists = (p: string) => stat(p).then(() => true, () => false);

describe("git reset steps", () => {
  let tmp: string;
  let repo: string;
  let wt: string;
  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "reset-git-")));
    g(tmp, "init", "-q", "--bare", "-b", "master", "origin.git");
    g(tmp, "clone", "-q", join(tmp, "origin.git"), "repo");
    repo = join(tmp, "repo");
    g(repo, "checkout", "-q", "-b", "master");
    await writeFile(join(repo, "a.txt"), "a\n");
    g(repo, "add", "a.txt");
    g(repo, "commit", "-q", "-m", "init");
    g(repo, "push", "-q", "origin", "master");
    wt = join(repo, ".claude", "worktrees");
    await mkdir(wt, { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const config = (): Config => ({ targetRepo: { url: join(tmp, "origin.git"), defaultBranch: "master", path: repo } }) as unknown as Config;
  const ctx = (over: Partial<ResetCtx> = {}): ResetCtx => ({
    project: "proj", slug: "proj", ticket: "TARS-1", role: "all", config: config(), root: tmp,
    jira: null, github: null, openPrHeads: async () => [], git, sandbox: null, sandboxConfig: null,
    isAlive: () => false, now: () => new Date(), closeRemote: false, ...over,
  });
  const surveyAll = async (c: ResetCtx): Promise<Survey[]> => {
    const out: Survey[] = [];
    for (const st of gitSteps(c)) out.push(await st.survey());
    return out;
  };
  const branches = (): string[] => g(repo, "for-each-ref", "refs/heads", "--format=%(refname:short)").trim().split("\n").filter(Boolean);
  const commitOn = async (b: string): Promise<void> => {
    g(repo, "checkout", "-q", "-b", b);
    await writeFile(join(repo, `${b}.txt`), "x\n");
    g(repo, "add", `${b}.txt`);
    g(repo, "commit", "-q", "-m", b);
    g(repo, "checkout", "-q", "master");
  };

  it("names the three steps in order", () => {
    const steps = gitSteps(ctx());
    expect(steps.map((s) => [s.area, s.name])).toEqual([["git", "worktrees"], ["git", "local branches"], ["git", "pushed branches / PRs"]]);
  });

  const RUN = "20261117T035443Z";
  it("removes a ticket's pipeline worktrees and prunes git's entry", async () => {
    g(repo, "worktree", "add", "-q", "-b", "TARS-1-dev", join(wt, `TARS-1-${RUN}`));
    await mkdir(join(wt, `TARS-1-${RUN}-baseline`));
    g(repo, "worktree", "add", "-q", "-b", "TARS-10-dev", join(wt, `TARS-10-${RUN}`));
    await writeFile(join(wt, `TARS-1-${RUN}`, "dirty.txt"), "uncommitted\n");
    const [s] = await surveyAll(ctx());
    expect(s).toMatchObject({ found: `TARS-1-${RUN}, TARS-1-${RUN}-baseline`, action: "remove 2 + prune" });
    await s.run!();
    expect(await exists(join(wt, `TARS-1-${RUN}`))).toBe(false);
    expect(await exists(join(wt, `TARS-1-${RUN}-baseline`))).toBe(false);
    expect(await exists(join(wt, `TARS-10-${RUN}`))).toBe(true);
    const list = g(repo, "worktree", "list", "--porcelain");
    expect(list).not.toContain(join(wt, `TARS-1-${RUN}`) + "\n");
    expect(list).toContain(join(wt, `TARS-10-${RUN}`));
    expect((await surveyAll(ctx()))[0]).toEqual({ found: "none", action: null });
  });

  it("lists every worktree it will remove in details, one per line, full name", async () => {
    for (const sfx of ["", "-ground", "-baseline"]) await mkdir(join(wt, `TARS-1-${RUN}${sfx}`));
    const [s] = await surveyAll(ctx());
    expect(s.action).toBe("remove 3 + prune");
    expect(s.details).toEqual([`remove TARS-1-${RUN}`, `remove TARS-1-${RUN}-baseline`, `remove TARS-1-${RUN}-ground`]);
  });

  it("never removes a person's own worktree; reports it as needs you", async () => {
    g(repo, "worktree", "add", "-q", "-b", "TARS-1-okta", join(wt, "TARS-1-okta-spike"));
    await mkdir(join(wt, "TARS-1-notes"));
    g(repo, "worktree", "add", "-q", "-b", "TARS-1-dev", join(wt, `TARS-1-${RUN}`));
    await mkdir(join(wt, `TARS-1-${RUN}-ground`));
    await mkdir(join(wt, `TARS-1-${RUN}-fu`));
    const [s] = await surveyAll(ctx());
    expect(s).toMatchObject({ action: "remove 3 + prune" });
    expect(s.needsYou).toBeUndefined();
    expect(s.details).toEqual([
      `remove TARS-1-${RUN}`, `remove TARS-1-${RUN}-fu`, `remove TARS-1-${RUN}-ground`,
      "needs you: TARS-1-notes is not a pipeline worktree", "needs you: TARS-1-okta-spike is not a pipeline worktree",
    ]);
    await s.run!();
    expect(await exists(join(wt, "TARS-1-okta-spike"))).toBe(true);
    expect(await exists(join(wt, "TARS-1-notes"))).toBe(true);
    expect(await exists(join(wt, `TARS-1-${RUN}`))).toBe(false);
    expect(await exists(join(wt, `TARS-1-${RUN}-ground`))).toBe(false);
    expect(g(repo, "worktree", "list", "--porcelain")).toContain(join(wt, "TARS-1-okta-spike"));
    const after = (await surveyAll(ctx()))[0];
    expect(after).toMatchObject({ action: null, needsYou: "TARS-1-notes, TARS-1-okta-spike: not a pipeline worktree" });
    expect(after.run).toBeUndefined();
  });

  it("ignores a ticket-named worktree outside .claude/worktrees", async () => {
    g(repo, "worktree", "add", "-q", "-b", "TARS-1-elsewhere", join(tmp, `TARS-1-${RUN}`));
    const [s] = await surveyAll(ctx());
    expect(s).toEqual({ found: "none", action: null });
  });

  it("research scope only removes -ground worktrees", async () => {
    g(repo, "worktree", "add", "-q", "--detach", join(wt, `TARS-1-${RUN}-ground`));
    g(repo, "worktree", "add", "-q", "-b", "TARS-1-dev", join(wt, `TARS-1-${RUN}`));
    const s = await surveyAll(ctx({ role: "research" }));
    expect(s[0]).toMatchObject({ found: `TARS-1-${RUN}-ground`, action: "remove 1 + prune" });
    expect(s[1]).toEqual({ found: "-", action: null });
    expect(s[2]).toEqual({ found: "-", action: null });
    await s[0].run!();
    expect(await exists(join(wt, `TARS-1-${RUN}-ground`))).toBe(false);
    expect(await exists(join(wt, `TARS-1-${RUN}`))).toBe(true);
    const dev = await surveyAll(ctx({ role: "dev" }));
    expect(dev[0]).toMatchObject({ found: `TARS-1-${RUN}`, action: "remove 1 + prune" });
  });

  it("deletes a 0-ahead local-only branch", async () => {
    g(repo, "branch", "TARS-1-a");
    const s = (await surveyAll(ctx()))[1];
    expect(s).toMatchObject({ found: "TARS-1-a (0 ahead)", action: "delete 1" });
    expect(s.needsYou).toBeUndefined();
    await s.run!();
    expect(branches()).toEqual(["master"]);
    expect((await surveyAll(ctx()))[1]).toEqual({ found: "none", action: null });
  });

  it("keeps a branch that is on origin", async () => {
    g(repo, "branch", "TARS-1-p");
    g(repo, "push", "-q", "origin", "TARS-1-p");
    const s = (await surveyAll(ctx()))[1];
    expect(s).toMatchObject({ found: "TARS-1-p (on origin)", action: null });
    expect(s.run).toBeUndefined();
    expect(branches()).toContain("TARS-1-p");
  });

  it("keeps a branch with an open PR", async () => {
    g(repo, "branch", "TARS-1-pr");
    const s = (await surveyAll(ctx({ openPrHeads: async () => [{ head: "TARS-1-pr", url: "https://x/pull/1" }] })))[1];
    expect(s).toMatchObject({ found: "TARS-1-pr (open PR)", action: null });
    expect(s.run).toBeUndefined();
  });

  it("a branch with unpushed commits is needs you", async () => {
    await commitOn("TARS-1-b");
    const s = (await surveyAll(ctx()))[1];
    expect(s).toMatchObject({ found: "TARS-1-b (1 unpushed)", action: null, needsYou: "TARS-1-b has 1 unpushed commit(s)" });
    expect(s.run).toBeUndefined();
    expect(branches()).toContain("TARS-1-b");
  });

  it("deletes the safe branches and lists the blocked ones in details", async () => {
    g(repo, "branch", "TARS-1-a");
    await commitOn("TARS-1-b");
    const s = (await surveyAll(ctx()))[1];
    expect(s).toMatchObject({
      found: "TARS-1-a (0 ahead), TARS-1-b (1 unpushed)",
      action: "delete 1",
      details: ["delete TARS-1-a (0 ahead)", "keep TARS-1-b (1 unpushed)", "needs you: TARS-1-b has 1 unpushed commit(s)"],
    });
    expect(s.needsYou).toBeUndefined();
    await s.run!();
    expect(branches().sort()).toEqual(["TARS-1-b", "master"]);
    expect((await surveyAll(ctx()))[1]).toMatchObject({ action: null, needsYou: "TARS-1-b has 1 unpushed commit(s)" });
  });

  it("never deletes the branch checked out in the repo", async () => {
    g(repo, "checkout", "-q", "-b", "TARS-1-here");
    const s = (await surveyAll(ctx()))[1];
    expect(s).toMatchObject({ action: null, needsYou: "TARS-1-here is checked out in repo" });
    expect(s.run).toBeUndefined();
  });

  it("a failing remote check makes the row needs you and deletes nothing", async () => {
    g(repo, "branch", "TARS-1-a");
    const boom = ctx({ openPrHeads: async () => { throw new Error("gh exploded\nstack"); } });
    const s = await surveyAll(boom);
    expect(s[1]).toMatchObject({ action: null, needsYou: "remote check failed: gh exploded" });
    expect(s[1].run).toBeUndefined();
    expect(s[2]).toMatchObject({ action: null, needsYou: "remote check failed: gh exploded" });
    const noCreds = (await surveyAll(ctx({ openPrHeads: null })))[1];
    expect(noCreds).toMatchObject({ action: null, needsYou: "remote check failed: no GitHub credentials" });
    g(repo, "remote", "set-url", "origin", join(tmp, "missing.git"));
    const offline = (await surveyAll(ctx()))[1];
    expect(offline.action).toBeNull();
    expect(offline.needsYou).toMatch(/^remote check failed: /);
    expect(offline.run).toBeUndefined();
    expect(branches()).toContain("TARS-1-a");
  });

  it("re-checks before delete and fails naming a branch pushed since the survey", async () => {
    g(repo, "branch", "TARS-1-a");
    g(repo, "branch", "TARS-1-c");
    const s = (await surveyAll(ctx()))[1];
    expect(s.action).toBe("delete 2");
    g(repo, "push", "-q", "origin", "TARS-1-a");
    await expect(s.run!()).rejects.toThrow(/TARS-1-a/);
    expect(branches().sort()).toEqual(["TARS-1-a", "master"]);
  });

  it("never matches TARS-10- for TARS-1", async () => {
    g(repo, "branch", "TARS-10-a");
    g(repo, "branch", "TARS-10-p");
    g(repo, "push", "-q", "origin", "TARS-10-p");
    g(repo, "worktree", "add", "-q", "-b", "TARS-10-dev", join(wt, `TARS-10-${RUN}`));
    const s = await surveyAll(ctx({ openPrHeads: async () => [{ head: "TARS-10-p", url: "https://x/pull/10" }] }));
    expect(s[0]).toEqual({ found: "none", action: null });
    expect(s[1]).toEqual({ found: "none", action: null });
    expect(s[2]).toEqual({ found: "none", action: null });
  });

  it("lists pushed branches and PRs without acting", async () => {
    g(repo, "branch", "TARS-1-p");
    g(repo, "push", "-q", "origin", "TARS-1-p");
    g(repo, "branch", "-D", "TARS-1-p");
    const s = (await surveyAll(ctx({ openPrHeads: async () => [{ head: "TARS-1-p", url: "https://x/pull/7" }] })))[2];
    expect(s).toEqual({ found: "TARS-1-p on origin, PR https://x/pull/7", action: null });
    expect(g(tmp, "--git-dir", join(tmp, "origin.git"), "branch", "--list", "TARS-1-p")).toContain("TARS-1-p");
  });

  it("no config makes every row needs you", async () => {
    const s = await surveyAll(ctx({ config: null }));
    for (const r of s) expect(r).toEqual({ found: "-", action: null, needsYou: "no project config" });
  });
});
