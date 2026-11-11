import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  loadLoopConfig,
  findPlaceholders,
  assertNoPlaceholders,
  repoSlugFromUrl,
  targetRepoAddDir,
  listAvailableProjects,
  resolveProjectConfigPath,
  requireCodeReviewFields,
} from "../../src/core/config.ts";
import type { Config } from "../../src/core/types.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      repoLabel: "repo:webtarsthree",
      claimStatus: { from: "To Do", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" AND labels = "{repoLabel}" ORDER BY created ASC',
        dev: 'labels = "{label}" AND labels = "{repoLabel}" AND assignee = "{assignee}" ORDER BY created ASC',
      },
      statusNames: { bounced: "Blocked", prOpen: "Code Review" },
      codeReviewFields: {
        piiField: "customfield_13504",
        piiNoImpactOptionId: "14310",
        qaNotesField: "customfield_14226",
      },
      ...overrides.jira,
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 45 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:fandango/webtarsthree.git", defaultBranch: "master" },
    github: { repo: "fandango/webtarsthree" },
    ...overrides,
  };
}

describe("repoSlugFromUrl", () => {
  it("derives a slug from an SSH URL with a .git suffix", () => {
    expect(repoSlugFromUrl("git@github.com:fandango/webtarsthree.git")).toBe("webtarsthree");
  });

  it("derives a slug from an HTTPS URL with a .git suffix", () => {
    expect(repoSlugFromUrl("https://github.com/fandango/webtarsthree.git")).toBe("webtarsthree");
  });

  it("derives a slug from an HTTPS URL without a .git suffix", () => {
    expect(repoSlugFromUrl("https://github.com/org/catalog-ui-management")).toBe(
      "catalog-ui-management",
    );
  });

  it("derives a slug from an SSH URL without a .git suffix", () => {
    expect(repoSlugFromUrl("git@github.com:org/catalog-ui-management")).toBe(
      "catalog-ui-management",
    );
  });
});

describe("targetRepoAddDir", () => {
  it("returns targetRepo.path when set, so the spawned claude session can be granted directory access to it", () => {
    const config = makeConfig({
      targetRepo: {
        url: "git@github.com:fandango/webtarsthree.git",
        defaultBranch: "master",
        path: "/Users/me/Repos/webtarsthree",
      },
    });
    expect(targetRepoAddDir(config)).toBe("/Users/me/Repos/webtarsthree");
  });

  it("returns null when targetRepo.path is unset (clone-based flow stays inside dev-loop's own cwd)", () => {
    const config = makeConfig({
      targetRepo: { url: "git@github.com:fandango/webtarsthree.git", defaultBranch: "master" },
    });
    expect(targetRepoAddDir(config)).toBeNull();
  });
});

describe("listAvailableProjects", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "list-projects-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists project names derived from pipeline.<name>.config.json files, sorted", async () => {
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    await fs.writeFile(path.join(dir, "pipeline.catalog-ui-management.config.json"), "{}", "utf8");
    expect(await listAvailableProjects(dir)).toEqual(["catalog-ui-management", "webtarsthree"]);
  });

  it("excludes pipeline.loop.config.json -- it is not a project", async () => {
    await fs.writeFile(path.join(dir, "pipeline.loop.config.json"), "{}", "utf8");
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    expect(await listAvailableProjects(dir)).toEqual(["webtarsthree"]);
  });

  it("returns an empty array when no pipeline configs exist", async () => {
    expect(await listAvailableProjects(dir)).toEqual([]);
  });

  it("returns an empty array when dir does not exist", async () => {
    expect(await listAvailableProjects(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});

describe("resolveProjectConfigPath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-project-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves a valid project name to its config path", async () => {
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    expect(await resolveProjectConfigPath("webtarsthree", dir)).toBe(
      path.join(dir, "pipeline.webtarsthree.config.json"),
    );
  });

  it("throws listing available projects when projectName is omitted", async () => {
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    await expect(resolveProjectConfigPath(undefined, dir)).rejects.toThrow(/webtarsthree/);
  });

  it("throws listing available projects when the named project's config file doesn't exist", async () => {
    await fs.writeFile(path.join(dir, "pipeline.webtarsthree.config.json"), "{}", "utf8");
    await expect(resolveProjectConfigPath("nonexistent", dir)).rejects.toThrow(/webtarsthree/);
  });

  it("never resolves 'loop' as if it were a project name", async () => {
    await fs.writeFile(path.join(dir, "pipeline.loop.config.json"), "{}", "utf8");
    await expect(resolveProjectConfigPath("loop", dir)).rejects.toThrow(/Unknown project "loop"/);
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads and parses a config file at the given path", async () => {
    const filePath = path.join(dir, "pipeline.webtarsthree.config.json");
    await fs.writeFile(filePath, JSON.stringify(makeConfig()), "utf8");
    const config = await loadConfig(filePath);
    expect(config.targetRepo.url).toBe("git@github.com:fandango/webtarsthree.git");
    expect(config.jira.handoffLabel).toBe("pipeline:dev");
  });

  it("throws if the file does not exist", async () => {
    await expect(loadConfig(path.join(dir, "does-not-exist.json"))).rejects.toThrow();
  });

  it("requires an explicit path -- there is no implicit default config file", async () => {
    // @ts-expect-error -- path is a required argument, not optional
    await expect(loadConfig()).rejects.toThrow();
  });
});

describe("loadLoopConfig", () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-config-test-"));
    originalCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads and parses pipeline.loop.config.json from the current directory by default", async () => {
    await fs.writeFile(
      path.join(dir, "pipeline.loop.config.json"),
      JSON.stringify({ pollIntervalSec: 60 }),
      "utf8",
    );
    const loopConfig = await loadLoopConfig();
    expect(loopConfig.pollIntervalSec).toBe(60);
  });

  it("reads from an explicit path when given one", async () => {
    const filePath = path.join(dir, "custom.loop.config.json");
    await fs.writeFile(filePath, JSON.stringify({ pollIntervalSec: 30 }), "utf8");
    const loopConfig = await loadLoopConfig(filePath);
    expect(loopConfig.pollIntervalSec).toBe(30);
  });

  it("carries postRunDelaySec through when present", async () => {
    await fs.writeFile(
      path.join(dir, "pipeline.loop.config.json"),
      JSON.stringify({ pollIntervalSec: 60, postRunDelaySec: 5 }),
      "utf8",
    );
    const loopConfig = await loadLoopConfig();
    expect(loopConfig.postRunDelaySec).toBe(5);
  });

  it("throws if the file does not exist", async () => {
    await expect(loadLoopConfig()).rejects.toThrow();
  });
});

describe("findPlaceholders / assertNoPlaceholders", () => {
  it("returns an empty array when no fields are placeholders", () => {
    expect(findPlaceholders(makeConfig())).toEqual([]);
  });

  it("lists every field still set to the placeholder value", () => {
    const config = makeConfig({
      jira: { ...makeConfig().jira, triggerLabel: "___", handoffLabel: "___" },
    });
    const missing = findPlaceholders(config);
    expect(missing).toContain("jira.triggerLabel");
    expect(missing).toContain("jira.handoffLabel");
  });

  it("lists jira.repoLabel when it's still set to the placeholder value", () => {
    const config = makeConfig({
      jira: { ...makeConfig().jira, repoLabel: "___" },
    });
    const missing = findPlaceholders(config);
    expect(missing).toContain("jira.repoLabel");
  });

  it("lists codeReviewFields sub-fields still set to the placeholder value", () => {
    const config = makeConfig({
      jira: {
        ...makeConfig().jira,
        codeReviewFields: { piiField: "___", piiNoImpactOptionId: "___", qaNotesField: "___" },
      },
    });
    const missing = findPlaceholders(config);
    expect(missing).toContain("jira.codeReviewFields.piiField");
    expect(missing).toContain("jira.codeReviewFields.piiNoImpactOptionId");
    expect(missing).toContain("jira.codeReviewFields.qaNotesField");
  });

  it("assertNoPlaceholders does not throw on a fully-bound config", () => {
    expect(() => assertNoPlaceholders(makeConfig())).not.toThrow();
  });

  it("assertNoPlaceholders throws naming every missing field", () => {
    const config = makeConfig({ autoPromoteLabel: "___" });
    expect(() => assertNoPlaceholders(config)).toThrow(/autoPromoteLabel/);
  });

  it("lists github.repo when it's still set to the placeholder value", () => {
    const config = makeConfig({ github: { repo: "___" } });
    const missing = findPlaceholders(config);
    expect(missing).toContain("github.repo");
  });
  // research-loop's config has no jira.codeReviewFields (dev-only key).
  describe("a research config (no jira.codeReviewFields)", () => {
    function researchConfig(): Config {
      const config = makeConfig();
      const { codeReviewFields: _crf, ...jira } = config.jira;
      return { ...config, jira };
    }

    it("is fully bound for the research role (the default)", () => {
      expect(findPlaceholders(researchConfig())).toEqual([]);
      expect(() => assertNoPlaceholders(researchConfig())).not.toThrow();
      expect(() => assertNoPlaceholders(researchConfig(), "research")).not.toThrow();
    });

    it("is rejected for the dev role, naming every missing codeReviewFields key", () => {
      const missing = findPlaceholders(researchConfig(), "dev");
      expect(missing).toEqual([
        "jira.codeReviewFields.piiField",
        "jira.codeReviewFields.piiNoImpactOptionId",
        "jira.codeReviewFields.qaNotesField",
      ]);
      expect(() => assertNoPlaceholders(researchConfig(), "dev")).toThrow(/codeReviewFields/);
    });
  });

  it("a fully-bound dev config passes the dev-role check", () => {
    expect(() => assertNoPlaceholders(makeConfig(), "dev")).not.toThrow();
  });
});

describe("requireCodeReviewFields", () => {
  it("returns jira.codeReviewFields when present", () => {
    expect(requireCodeReviewFields(makeConfig()).piiField).toBe("customfield_13504");
  });

  it("throws when the dev-only block is absent", () => {
    const config = makeConfig();
    const { codeReviewFields: _crf, ...jira } = config.jira;
    expect(() => requireCodeReviewFields({ ...config, jira })).toThrow(/codeReviewFields/);
  });
});
