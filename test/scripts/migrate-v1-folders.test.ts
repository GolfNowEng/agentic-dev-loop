// scripts/migrate-v1-folders.mjs driven as a subprocess against temp roots.
// The process check is injected via CUTOVER_PGREP (a stub executable), so no
// test depends on a real loop running on this machine.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, symlink, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = promisify(execFile);
const SCRIPT = resolve(import.meta.dirname, "../../scripts/migrate-v1-folders.mjs");

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const name of (await readdir(d)).sort()) {
      const p = join(d, name);
      if ((await stat(p)).isDirectory()) {
        out.push(`${p}/`);
        await walk(p);
      } else out.push(`${p}=${await readFile(p, "utf8")}`);
    }
  }
  await walk(dir);
  return out;
}

async function stub(dir: string, name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

describe("scripts/migrate-v1-folders.mjs", () => {
  let tmp: string, dev: string, research: string, noLoop: string, loop: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "migrate-test-"));
    dev = join(tmp, "dev");
    research = join(tmp, "research");
    for (const d of [
      join(dev, "runs/v2"), join(dev, ".pipeline/v2/x"), join(dev, ".pipeline/webtarsthree/run1"),
      join(dev, ".pipeline/v1"), join(research, "runs"), join(research, ".pipeline/webtarsthree"),
    ]) await mkdir(d, { recursive: true });
    await writeFile(join(dev, "runs/webtarsthree.jsonl"), "d1\n");
    await writeFile(join(dev, "runs/webtarsthree.reset-archive.jsonl"), "d2\n");
    await writeFile(join(dev, "runs/v2/keep.jsonl"), "v2\n");
    await writeFile(join(dev, ".pipeline/webtarsthree/run1/progress.jsonl"), "p\n");
    await writeFile(join(dev, ".pipeline/v2/x/a"), "v2\n");
    await writeFile(join(research, "runs/webtarsthree.jsonl"), "r1\n");
    await writeFile(join(research, ".pipeline/webtarsthree/f"), "rf\n");
    noLoop = await stub(tmp, "pgrep-none", "exit 1");
    loop = await stub(tmp, "pgrep-loop", 'echo "4242 node src/main.ts --project webtarsthree"; exit 0');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const go = (args: string[], pgrep: string) =>
    run("node", [SCRIPT, `--dev-root=${dev}`, `--research-root=${research}`, ...args], {
      env: { ...process.env, CUTOVER_PGREP: pgrep },
    }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));

  it("prints the exact plan, sorted, and moves nothing without --write", async () => {
    const before = await snapshot(tmp);
    const r = await go([], noLoop);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        `move ${dev}/.pipeline/webtarsthree -> ${dev}/.pipeline/v1/dev/webtarsthree`,
        `move ${dev}/runs/webtarsthree.jsonl -> ${dev}/runs/v1/dev/webtarsthree.jsonl`,
        `move ${dev}/runs/webtarsthree.reset-archive.jsonl -> ${dev}/runs/v1/dev/webtarsthree.reset-archive.jsonl`,
        `move ${research}/.pipeline/webtarsthree -> ${dev}/.pipeline/v1/research/webtarsthree`,
        `move ${research}/runs/webtarsthree.jsonl -> ${dev}/runs/v1/research/webtarsthree.jsonl`,
        "",
      ].join("\n"),
    );
    expect(await snapshot(tmp)).toEqual(before);
  });

  it("--write performs the moves and leaves v2 untouched", async () => {
    const r = await go(["--write"], noLoop);
    expect(r.code).toBe(0);
    expect(await readFile(join(dev, "runs/v1/dev/webtarsthree.jsonl"), "utf8")).toBe("d1\n");
    expect(await readFile(join(dev, "runs/v1/dev/webtarsthree.reset-archive.jsonl"), "utf8")).toBe("d2\n");
    expect(await readFile(join(dev, "runs/v1/research/webtarsthree.jsonl"), "utf8")).toBe("r1\n");
    expect(await readFile(join(dev, ".pipeline/v1/dev/webtarsthree/run1/progress.jsonl"), "utf8")).toBe("p\n");
    expect(await readFile(join(dev, ".pipeline/v1/research/webtarsthree/f"), "utf8")).toBe("rf\n");
    expect(await readFile(join(dev, "runs/v2/keep.jsonl"), "utf8")).toBe("v2\n");
    expect(await readFile(join(dev, ".pipeline/v2/x/a"), "utf8")).toBe("v2\n");
    await expect(stat(join(dev, "runs/webtarsthree.jsonl"))).rejects.toThrow();
    await expect(stat(join(research, "runs/webtarsthree.jsonl"))).rejects.toThrow();
  });

  it("refuses the whole run when any destination exists", async () => {
    await mkdir(join(dev, "runs/v1/research"), { recursive: true });
    await writeFile(join(dev, "runs/v1/research/webtarsthree.jsonl"), "old\n");
    const before = await snapshot(tmp);
    const r = await go(["--write"], noLoop);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("exists");
    expect(await snapshot(tmp)).toEqual(before);
  });

  it("refuses --write when a v1 loop process is running", async () => {
    const before = await snapshot(tmp);
    const r = await go(["--write"], loop);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("src/main.ts");
    expect(await snapshot(tmp)).toEqual(before);
  });

  it("refuses when both roots resolve to the same directory (even via symlink)", async () => {
    const alias = join(tmp, "alias");
    await symlink(dev, alias);
    const r = await run("node", [SCRIPT, `--dev-root=${dev}`, `--research-root=${alias}`], {
      env: { ...process.env, CUTOVER_PGREP: noLoop },
    }).then((x) => ({ code: 0, ...x }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("same directory");
    expect(r.stdout).toBe("");
  });

  it("refuses the whole run before moving anything when a source is on another device", async () => {
    const before = await snapshot(tmp);
    const r = await run("node", [SCRIPT, `--dev-root=${dev}`, `--research-root=${research}`, "--write"], {
      env: { ...process.env, CUTOVER_PGREP: noLoop, CUTOVER_FAKE_OTHER_DEVICE: research },
    }).then((x) => ({ code: 0, ...x }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("different filesystem");
    expect(await snapshot(tmp)).toEqual(before);
  });

  it("dry run still prints the plan and warns (exit 0) when a loop is running", async () => {
    const before = await snapshot(tmp);
    const r = await go([], loop);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`move ${dev}/runs/webtarsthree.jsonl`);
    expect(r.stdout).toContain("WARNING");
    expect(r.stdout).toContain("--write will refuse");
    expect(await snapshot(tmp)).toEqual(before);
  });

  it("handles dangling symlinks: no crash, moved as links", async () => {
    await symlink(join(tmp, "nowhere"), join(dev, "runs/dangling.jsonl"));
    await symlink(join(tmp, "nowhere"), join(dev, ".pipeline/dangling-slug"));
    const dry = await go([], noLoop);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("runs/dangling.jsonl");
    const r = await go(["--write"], noLoop);
    expect(r.code).toBe(0);
    expect((await lstat(join(dev, "runs/v1/dev/dangling.jsonl"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(dev, ".pipeline/v1/dev/dangling-slug"))).isSymbolicLink()).toBe(true);
  });

  it("refuses the old --name value form, naming the replacement", async () => {
    const r = await run("node", [SCRIPT, "--dev-root", dev]).then(() => ({ stderr: "" }), (e) => ({ stderr: e.stderr as string }));
    expect(r.stderr).toContain(`use --dev-root=${dev}`);
  });

  it("requires both roots", async () => {
    const r = await run("node", [SCRIPT, `--dev-root=${dev}`]).then(() => ({ code: 0 }), (e) => ({ code: e.code as number }));
    expect(r.code).not.toBe(0);
  });

  describe("--v2-from <worktree> (final review I1, Ruling 40)", () => {
    let wt: string, main: string;
    beforeEach(async () => {
      wt = join(tmp, "worktree");
      main = join(tmp, "main");
      await mkdir(join(wt, "runs/v2"), { recursive: true });
      await mkdir(join(wt, ".pipeline/v2/webtarsthree/sessions"), { recursive: true });
      await writeFile(join(wt, "runs/v2/webtarsthree.jsonl"), "landed #580\n");
      await writeFile(join(wt, ".pipeline/v2/webtarsthree/sessions/dev-1.lock"), "{}\n");
      await mkdir(join(main, "runs"), { recursive: true });
    });

    const v2go = (args: string[], pgrep: string, env: Record<string, string> = {}) =>
      run("node", [SCRIPT, ...args], { env: { ...process.env, CUTOVER_PGREP: pgrep, ...env } }).then(
        (r) => ({ code: 0, ...r }),
        (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }),
      );

    it("on its own (no --research-root): dry run prints exactly the two v2 moves and moves nothing", async () => {
      const before = await snapshot(tmp);
      const r = await v2go([`--dev-root=${main}`, `--v2-from=${wt}`], noLoop);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(
        [`move ${wt}/.pipeline/v2 -> ${main}/.pipeline/v2`, `move ${wt}/runs/v2 -> ${main}/runs/v2`, ""].join("\n"),
      );
      expect(await snapshot(tmp)).toEqual(before);
    });

    it("--write moves runs/v2 and .pipeline/v2 into the dev root", async () => {
      const r = await v2go([`--dev-root=${main}`, `--v2-from=${wt}`, "--write"], noLoop);
      expect(r.code).toBe(0);
      expect(await readFile(join(main, "runs/v2/webtarsthree.jsonl"), "utf8")).toBe("landed #580\n");
      expect(await readFile(join(main, ".pipeline/v2/webtarsthree/sessions/dev-1.lock"), "utf8")).toBe("{}\n");
      await expect(stat(join(wt, "runs/v2"))).rejects.toThrow();
      await expect(stat(join(wt, ".pipeline/v2"))).rejects.toThrow();
    });

    it("plans only the sources that exist", async () => {
      await rm(join(wt, ".pipeline"), { recursive: true });
      const r = await v2go([`--dev-root=${main}`, `--v2-from=${wt}`], noLoop);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`move ${wt}/runs/v2 -> ${main}/runs/v2\n`);
    });

    it("combines with --research-root: the v1 moves plus the v2 moves, sorted", async () => {
      const r = await v2go([`--dev-root=${dev}`, `--research-root=${research}`, `--v2-from=${wt}`], noLoop);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`move ${wt}/runs/v2 -> ${dev}/runs/v2`);
      expect(r.stdout).toContain(`move ${dev}/runs/webtarsthree.jsonl -> ${dev}/runs/v1/dev/webtarsthree.jsonl`);
    });

    it("refuses when a destination exists (the dev root already has runs/v2)", async () => {
      await mkdir(join(main, "runs/v2"), { recursive: true });
      const before = await snapshot(tmp);
      const r = await v2go([`--dev-root=${main}`, `--v2-from=${wt}`, "--write"], noLoop);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("destination exists");
      expect(await snapshot(tmp)).toEqual(before);
    });

    it("refuses --write while a loop is running", async () => {
      const before = await snapshot(tmp);
      const r = await v2go([`--dev-root=${main}`, `--v2-from=${wt}`, "--write"], loop);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("src/main.ts");
      expect(await snapshot(tmp)).toEqual(before);
    });

    it("refuses a cross-device move before moving anything", async () => {
      const before = await snapshot(tmp);
      const r = await v2go([`--dev-root=${main}`, `--v2-from=${wt}`, "--write"], noLoop, { CUTOVER_FAKE_OTHER_DEVICE: wt });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("different filesystem");
      expect(await snapshot(tmp)).toEqual(before);
    });

    it("refuses when --v2-from is the dev root (even via symlink)", async () => {
      const alias = join(tmp, "alias-main");
      await symlink(main, alias);
      const r = await v2go([`--dev-root=${main}`, `--v2-from=${alias}`], noLoop);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("same directory");
      expect(r.stdout).toBe("");
    });

    it("still requires --research-root when --v2-from is absent", async () => {
      const r = await v2go([`--dev-root=${main}`], noLoop);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("--research-root");
    });
  });
});
