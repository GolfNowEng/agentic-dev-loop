import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { snapshotRunDirs, findNewestRunDir } from "../../src/core/run-dirs.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("snapshotRunDirs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-dirs-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns an empty set when the base directory does not exist yet", async () => {
    const snapshot = await snapshotRunDirs(path.join(dir, "does-not-exist"), "PROJ-1");
    expect(snapshot.size).toBe(0);
  });

  it("returns only entries matching the ticket's own prefix", async () => {
    await fs.mkdir(path.join(dir, "PROJ-1-20260816T120000Z"));
    await fs.mkdir(path.join(dir, "PROJ-2-20260816T120000Z"));
    await fs.mkdir(path.join(dir, "PROJ-10-20260816T120000Z"));

    const snapshot = await snapshotRunDirs(dir, "PROJ-1");
    expect(snapshot).toEqual(new Set(["PROJ-1-20260816T120000Z"]));
  });

  it("ignores non-directory entries", async () => {
    await fs.mkdir(path.join(dir, "PROJ-1-20260816T120000Z"));
    await fs.writeFile(path.join(dir, "PROJ-1-stray-file"), "not a dir", "utf8");

    const snapshot = await snapshotRunDirs(dir, "PROJ-1");
    expect(snapshot).toEqual(new Set(["PROJ-1-20260816T120000Z"]));
  });
});

describe("findNewestRunDir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-dirs-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when no new directory appeared", async () => {
    await fs.mkdir(path.join(dir, "PROJ-1-20260816T120000Z"));
    const before = await snapshotRunDirs(dir, "PROJ-1");

    const newest = await findNewestRunDir(dir, "PROJ-1", before);
    expect(newest).toBeNull();
  });

  it("returns the one new directory that appeared", async () => {
    await fs.mkdir(path.join(dir, "PROJ-1-20260816T120000Z"));
    const before = await snapshotRunDirs(dir, "PROJ-1");

    await fs.mkdir(path.join(dir, "PROJ-1-20260816T130000Z"));

    const newest = await findNewestRunDir(dir, "PROJ-1", before);
    expect(newest).toBe("PROJ-1-20260816T130000Z");
  });

  it("returns the lexicographically newest of multiple new directories", async () => {
    const before = await snapshotRunDirs(dir, "PROJ-1");

    await fs.mkdir(path.join(dir, "PROJ-1-20260816T120000Z"));
    await fs.mkdir(path.join(dir, "PROJ-1-20260816T130000Z"));
    await fs.mkdir(path.join(dir, "PROJ-1-20260816T090000Z"));

    const newest = await findNewestRunDir(dir, "PROJ-1", before);
    expect(newest).toBe("PROJ-1-20260816T130000Z");
  });

  it("never returns a directory belonging to a different ticket", async () => {
    const before = await snapshotRunDirs(dir, "PROJ-1");

    await fs.mkdir(path.join(dir, "PROJ-2-20260816T120000Z"));

    const newest = await findNewestRunDir(dir, "PROJ-1", before);
    expect(newest).toBeNull();
  });

  it("returns null when the base directory does not exist", async () => {
    const before = await snapshotRunDirs(path.join(dir, "nope"), "PROJ-1");
    const newest = await findNewestRunDir(path.join(dir, "nope"), "PROJ-1", before);
    expect(newest).toBeNull();
  });
});
