// scripts/migrate-v1-folders.mjs driven as a subprocess against temp roots.
// The process check is injected via CUTOVER_PGREP (a stub executable), so no
// test depends on a real loop running on this machine.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    run("node", [SCRIPT, "--dev-root", dev, "--research-root", research, ...args], {
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

  it("requires both roots", async () => {
    const r = await run("node", [SCRIPT, "--dev-root", dev]).then(() => ({ code: 0 }), (e) => ({ code: e.code as number }));
    expect(r.code).not.toBe(0);
  });
});
