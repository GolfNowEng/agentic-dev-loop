import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realGit, signUnpushed } from "../../src/worker/host-sign.ts";

let hasKeygen = true;
try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); } catch (e) {
  hasKeygen = (e as NodeJS.ErrnoException).code !== "ENOENT";
}
if (!hasKeygen) console.warn("host-sign tests skipped: ssh-keygen not found");

describe.skipIf(!hasKeygen)("signUnpushed", () => {
  let tmp: string, bare: string, wt: string, key: string;
  let git: ReturnType<typeof realGit>;
  const g = async (...a: string[]) => (await git(a, wt)).trim();
  const agent = ["-c", "user.email=agent@sandbox", "-c", "user.name=agent"];
  const commit = async (file: string, msg: string) => {
    writeFileSync(join(wt, file), msg);
    await g("add", "-A");
    await g(...agent, "commit", "-q", "-m", msg);
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "hostsign-"));
    key = join(tmp, "k");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", key]);
    writeFileSync(join(tmp, "gitconfig"), "");
    writeFileSync(join(tmp, "allowed"), `t@example.com ${readFileSync(key + ".pub", "utf8").trim()}\n`);
    git = realGit({ ...process.env, GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  beforeEach(async () => {
    bare = join(tmp, "origin.git");
    wt = join(tmp, "wt");
    rmSync(bare, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
    await git(["init", "-q", "--bare", "-b", "main", bare], tmp);
    await git(["init", "-q", "-b", "main", wt], tmp);
    for (const [k, v] of [
      ["user.name", "T"], ["user.email", "t@example.com"], ["gpg.format", "ssh"],
      ["user.signingkey", key], ["gpg.ssh.allowedSignersFile", join(tmp, "allowed")],
      ["commit.gpgsign", "false"],
    ]) await g("config", k, v);
    await g("remote", "add", "origin", bare);
    writeFileSync(join(wt, "base"), "base");
    await g("add", "-A");
    await g("commit", "-q", "-m", "base");
    await g("push", "-q", "origin", "main");
    await g("checkout", "-q", "-b", "X-1-a");
  });

  const args = (branch = "X-1-a") => ({ worktree: wt, branch, ticketKey: "X-1", defaultBranch: "main", git });

  it("signs only the unpushed commits and resets the author", async () => {
    const mainSha = (await git(["rev-parse", "main"], bare)).trim();
    await commit("a", "one");
    await commit("b", "two");
    const tree = await g("rev-parse", "HEAD^{tree}");
    const r = await signUnpushed(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signed).toBe(2);
    expect((await g("log", "--format=%G?", "origin/main..HEAD")).split("\n")).toEqual(["G", "G"]);
    expect((await g("log", "--format=%ae", "origin/main..HEAD")).split("\n")).toEqual(["t@example.com", "t@example.com"]);
    expect(await g("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect((await git(["rev-parse", "main"], bare)).trim()).toBe(mainSha);
  });

  it("base is origin/<branch> when the branch is already pushed", async () => {
    await commit("a", "one");
    await g("push", "-q", "origin", "X-1-a");
    await commit("b", "two");
    const r = await signUnpushed(args());
    expect(r.ok && r.signed).toBe(1);
  });

  it("F1: keeps the merge-base when origin/main moved after the fork", async () => {
    await commit("a", "one");
    await commit("b", "two");
    const fork = await g("merge-base", "HEAD", "origin/main");
    const tree = await g("rev-parse", "HEAD^{tree}");
    await g("checkout", "-q", "main");
    await commit("m", "main moved");
    await g("push", "-q", "origin", "main");
    await g("checkout", "-q", "X-1-a");
    await g("fetch", "-q", "origin");
    expect(await g("rev-parse", "origin/main")).not.toBe(fork);
    const r = await signUnpushed(args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signed).toBe(2);
    expect(r.base).toBe(fork);
    expect(await g("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(await g("merge-base", "HEAD", "origin/main")).toBe(fork);
    expect((await g("log", "--format=%G?", `${fork}..HEAD`)).split("\n")).toEqual(["G", "G"]);
    expect(await g("log", "--format=%G?", "-1", fork)).toBe("N");
  });

  it("F1: pushed branch whose origin tip is not an ancestor is refused", async () => {
    await commit("a", "one");
    await g("push", "-q", "origin", "X-1-a");
    await g("reset", "-q", "--hard", "HEAD~1");
    await commit("b", "two");
    const head = await g("rev-parse", "HEAD");
    const r = await signUnpushed(args());
    expect(r).toEqual({ ok: false, reason: "origin/X-1-a is not an ancestor of HEAD (diverged); refusing to rewrite", restored: false });
    expect(await g("rev-parse", "HEAD")).toBe(head);
  });

  it("F1: pushed branch base is the origin/<branch> sha", async () => {
    await commit("a", "one");
    await g("push", "-q", "origin", "X-1-a");
    const pushedSha = await g("rev-parse", "HEAD");
    await commit("b", "two");
    const r = await signUnpushed(args());
    expect(r.ok && r.base).toBe(pushedSha);
  });

  it("F1/#10: refuses a commit already on another origin ref", async () => {
    await commit("a", "one");
    const a = await g("rev-parse", "HEAD");
    await g("push", "-q", "origin", "HEAD:refs/heads/other");
    await commit("b", "two");
    const r = await signUnpushed(args());
    expect(r).toEqual({ ok: false, reason: `${a} is already on origin; refusing to rewrite pushed history`, restored: false });
  });

  it("refuses a merge commit", async () => {
    await commit("a", "one");
    await g("checkout", "-q", "-b", "side", "main");
    await commit("s", "side");
    await g("checkout", "-q", "X-1-a");
    await g(...agent, "merge", "-q", "--no-ff", "-m", "merge", "side");
    const head = await g("rev-parse", "HEAD");
    const r = await signUnpushed(args());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/merge commit/);
    expect(await g("rev-parse", "HEAD")).toBe(head);
  });

  it("refuses a dirty worktree", async () => {
    await commit("a", "one");
    writeFileSync(join(wt, "dirty"), "x");
    const r = await signUnpushed(args());
    expect(r).toEqual({ ok: false, reason: `worktree ${wt} has uncommitted changes`, restored: false });
  });

  it("refuses a wrong HEAD", async () => {
    await commit("a", "one");
    const r = await signUnpushed(args("X-1-b"));
    expect(r).toEqual({ ok: false, reason: "HEAD is X-1-a, expected X-1-b", restored: false });
  });

  it("refuses a branch without the key", async () => {
    await g("checkout", "-q", "-b", "other");
    await commit("a", "one");
    const r = await signUnpushed(args("other"));
    expect(r).toEqual({ ok: false, reason: "branch other does not name X-1", restored: false });
  });

  it("restores the old tip when signing fails", async () => {
    await commit("a", "one");
    await commit("b", "two");
    const old = await g("rev-parse", "HEAD");
    await g("config", "user.signingkey", join(tmp, "missing"));
    const r = await signUnpushed(args());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.restored).toBe(true);
    expect(await g("rev-parse", "HEAD")).toBe(old);
    expect(await g("status", "--porcelain")).toBe("");
  });

  it("restores when a pre-commit hook fails on the second commit", async () => {
    await commit("a", "one");
    await commit("FAILMARK", "two");
    const old = await g("rev-parse", "HEAD");
    const hook = join(wt, ".git", "hooks", "pre-commit");
    writeFileSync(hook, '#!/bin/sh\n[ -e FAILMARK ] && exit 1\nexit 0\n');
    chmodSync(hook, 0o755);
    const r = await signUnpushed(args());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.restored).toBe(true);
    expect(await g("rev-parse", "HEAD")).toBe(old);
  });

  it("a pushed branch already at its origin tip needs no signing (a retry after a PR failure)", async () => {
    await commit("a", "one");
    await g("push", "-q", "origin", "X-1-a");
    const tip = await g("rev-parse", "HEAD");
    const r = await signUnpushed(args());
    expect(r).toEqual({ ok: true, base: tip, oldTip: tip, newTip: tip, signed: 0 });
  });

  it("nothing to sign", async () => {
    const r = await signUnpushed(args());
    expect(r).toEqual({ ok: false, reason: "nothing to sign on X-1-a", restored: false });
  });
});

describe("realGit timeout (F9)", () => {
  it("kills a git call that outlives timeoutMs", async () => {
    // hash-object --stdin waits on an open stdin pipe until killed.
    await expect(realGit(process.env, 300)(["hash-object", "--stdin"], tmpdir())).rejects.toThrow();
  });
});
