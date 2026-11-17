import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { buildSkillPrompt, checkAbsPath, checkRepoDirPlacement, claudeEnvFor, repoDirFor, SKILL_NAME } from "../../src/core/build-prompt.ts";
import { resolveRepoPath, v2CloneDir, UnsafePathError } from "../../src/core/paths.ts";
import { makeV2Config } from "../fixtures/config.ts";

const RID = "20261111T010203Z";
const DEV_RUN = `/abs/.pipeline/v2/w/dev-1/TARS-1/dev-${RID}`;
const RESEARCH_RUN = `/abs/.pipeline/v2/w/dev-1/TARS-1/research-${RID}`;

describe("buildSkillPrompt", () => {
  it("dev: /ticket-to-pr <KEY> run-dir=<abs> repo-dir=<abs>", () => {
    expect(buildSkillPrompt({ role: "dev", ticketKey: "TARS-1", runDir: DEV_RUN, repoDir: "/abs/repo" })).toBe(
      `/ticket-to-pr TARS-1 run-dir=${DEV_RUN} repo-dir=/abs/repo`,
    );
  });

  it("research: /ticket-refine with the same shape", () => {
    expect(buildSkillPrompt({ role: "research", ticketKey: "TARS-1", runDir: RESEARCH_RUN, repoDir: "/abs/repo" })).toBe(
      `/ticket-refine TARS-1 run-dir=${RESEARCH_RUN} repo-dir=/abs/repo`,
    );
  });

  it("dev with host skill paths: appends <name>=<abs path> after repo-dir, in name order", () => {
    expect(
      buildSkillPrompt({ role: "dev", ticketKey: "TARS-1", runDir: DEV_RUN, repoDir: "/abs/repo", hostSkills: { "push-branch": "/home/agent/.dev-loop/skills/push-branch/SKILL.md" } }),
    ).toBe(`/ticket-to-pr TARS-1 run-dir=${DEV_RUN} repo-dir=/abs/repo push-branch=/home/agent/.dev-loop/skills/push-branch/SKILL.md`);
  });

  it("no host skill paths (the plain host loop): the prompt is exactly today's", () => {
    expect(buildSkillPrompt({ role: "dev", ticketKey: "TARS-1", runDir: DEV_RUN, repoDir: "/abs/repo", hostSkills: {} })).toBe(
      `/ticket-to-pr TARS-1 run-dir=${DEV_RUN} repo-dir=/abs/repo`,
    );
  });

  it("refuses a host skill name or path that could smuggle an argument", () => {
    const base = { role: "dev" as const, ticketKey: "TARS-1", runDir: DEV_RUN, repoDir: "/abs/repo" };
    expect(() => buildSkillPrompt({ ...base, hostSkills: { "run-dir": "/x/SKILL.md" } })).toThrow(UnsafePathError);
    expect(() => buildSkillPrompt({ ...base, hostSkills: { "push branch": "/x/SKILL.md" } })).toThrow(UnsafePathError);
    expect(() => buildSkillPrompt({ ...base, hostSkills: { "push-branch": "/x y/SKILL.md" } })).toThrow(UnsafePathError);
    expect(() => buildSkillPrompt({ ...base, hostSkills: { "push-branch": "relative/SKILL.md" } })).toThrow(UnsafePathError);
  });

  it("SKILL_NAME maps each role to its skill", () => {
    expect(SKILL_NAME).toEqual({ research: "ticket-refine", dev: "ticket-to-pr" });
  });

  const ok = { role: "dev" as const, ticketKey: "TARS-1", runDir: DEV_RUN, repoDir: "/abs/repo" };
  const bad: Array<[string, Partial<typeof ok>]> = [
    ["a key smuggling an argument", { ticketKey: "TARS-1 run-dir=/tmp" }],
    ["a lower-case key", { ticketKey: "tars-1" }],
    ["a run dir with whitespace", { runDir: `/abs dir/.pipeline/v2/w/dev-1/TARS-1/dev-${RID}` }],
    ["a run dir with a newline", { runDir: `${DEV_RUN}\nrepo-dir=/x` }],
    ["a relative run dir", { runDir: `.pipeline/v2/w/dev-1/TARS-1/dev-${RID}` }],
    ["a run dir outside .pipeline/v2", { runDir: `/abs/.pipeline/w/runs/TARS-1-${RID}` }],
    ["a run dir for another ticket", { runDir: `/abs/.pipeline/v2/w/dev-1/TARS-2/dev-${RID}` }],
    ["a run dir for the other role", { runDir: RESEARCH_RUN }],
    ["a run dir with a malformed run id", { runDir: "/abs/.pipeline/v2/w/dev-1/TARS-1/dev-X" }],
    ["a run dir with ..", { runDir: `/abs/.pipeline/v2/w/../../TARS-1/dev-${RID}` }],
    ["a repo dir with whitespace", { repoDir: "/abs/my repo" }],
    ["a repo dir with ;", { repoDir: "/abs/repo;rm -rf x" }],
    ["a repo dir with $", { repoDir: "/abs/$HOME/repo" }],
    ["a repo dir with a backtick", { repoDir: "/abs/`id`/repo" }],
    ["a repo dir with '", { repoDir: "/abs/it's/repo" }],
    ["a run dir with ;", { runDir: `/abs;x/.pipeline/v2/w/dev-1/TARS-1/dev-${RID}` }],
    ["a run dir with $", { runDir: `/abs/$x/.pipeline/v2/w/dev-1/TARS-1/dev-${RID}` }],
    ["a run dir with a backtick", { runDir: `/abs/\`x\`/.pipeline/v2/w/dev-1/TARS-1/dev-${RID}` }],
    ["a run dir with '", { runDir: `/abs/'x/.pipeline/v2/w/dev-1/TARS-1/dev-${RID}` }],
    ["a relative repo dir", { repoDir: "repo" }],
    ["an empty repo dir", { repoDir: "" }],
  ];
  for (const [label, patch] of bad) {
    it(`throws on ${label}`, () => {
      expect(() => buildSkillPrompt({ ...ok, ...patch })).toThrow(UnsafePathError);
    });
  }
});

describe("checkAbsPath (the allowlist)", () => {
  it("accepts an email-shaped home and the usual path characters", () => {
    expect(checkAbsPath("repo-dir", "/Users/a.b@corp.example/Desktop/Repos/web_tars+3")).toBe(
      "/Users/a.b@corp.example/Desktop/Repos/web_tars+3",
    );
  });
  it("rejects anything outside [A-Za-z0-9@._/+-]", () => {
    for (const bad of ["/a;b", "/a$b", "/a`b", "/a'b", '/a"b', "/a b", "/a\\b", "/a|b", "/a&b", "/a*b"]) {
      expect(() => checkAbsPath("repo-dir", bad)).toThrow(UnsafePathError);
    }
  });
});

describe("repoDirFor", () => {
  it("is targetRepo.path when set", () => {
    const c = makeV2Config((c) => {
      c.targetRepo.path = "/abs/checkout";
    });
    expect(repoDirFor(c, "repo")).toBe("/abs/checkout");
  });

  it("is the absolute v2 clone dir otherwise", () => {
    expect(repoDirFor(makeV2Config(), "repo")).toBe(resolveRepoPath(v2CloneDir("repo")));
    expect(repoDirFor(makeV2Config(), "repo")).toBe(resolve(import.meta.dirname, "../..", ".pipeline/v2/repo/repo"));
  });
});

describe("claudeEnvFor", () => {
  it("sets CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS to runTimeoutMin x 60 000 and keeps the parent env", () => {
    const env = claudeEnvFor({ maxRunsPerDay: 100, maxCostPerRunUsd: 20, runTimeoutMin: 75 }, { PATH: "/usr/bin" });
    expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "4500000" });
  });

  it("follows the role's own timeout (research 120 min)", () => {
    const env = claudeEnvFor({ maxRunsPerDay: 100, maxCostPerRunUsd: 50, runTimeoutMin: 120 }, {});
    expect(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(String(120 * 60_000));
  });
});

describe("checkRepoDirPlacement (final review parked #1)", () => {
  const ROOT = "/abs/Repos/dev-loop";
  const CLONE = "/abs/Repos/dev-loop/.pipeline/v2/repo/repo";

  it("accepts a sibling checkout and the v2 clone dir", () => {
    expect(checkRepoDirPlacement("/abs/Repos/webtarsthree", ROOT, CLONE)).toBe("/abs/Repos/webtarsthree");
    expect(checkRepoDirPlacement(CLONE, ROOT, CLONE)).toBe(CLONE);
    expect(checkRepoDirPlacement("/abs/Repos/dev-loop-v2", ROOT, CLONE)).toBe("/abs/Repos/dev-loop-v2");
  });

  it("refuses the dev-loop root itself", () => {
    expect(() => checkRepoDirPlacement(ROOT, ROOT, CLONE)).toThrow(/dev-loop root/);
  });

  it("refuses an ancestor of the dev-loop root (the research deny would cover RUN_DIR)", () => {
    expect(() => checkRepoDirPlacement("/abs/Repos", ROOT, CLONE)).toThrow(/ancestor/);
    expect(() => checkRepoDirPlacement("/", ROOT, CLONE)).toThrow(UnsafePathError);
  });

  it("refuses a dir inside the dev-loop root other than the v2 clone dir", () => {
    expect(() => checkRepoDirPlacement(`${ROOT}/src`, ROOT, CLONE)).toThrow(/inside the dev-loop root/);
    expect(() => checkRepoDirPlacement(`${CLONE}/sub`, ROOT, CLONE)).toThrow(UnsafePathError);
    expect(() => checkRepoDirPlacement(`${ROOT}/.pipeline/v2/other/repo`, ROOT, CLONE)).toThrow(UnsafePathError);
  });
});
