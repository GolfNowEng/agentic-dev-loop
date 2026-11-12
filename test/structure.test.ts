// Structural checks (spec §9.3): cheap, every change. What a skill, agent or
// hook names must exist; no skill hardcodes `.pipeline/`; nothing in the
// pipeline's own code or prose reaches for a banned git/gh flag.

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) return [];
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "worktrees" ? [] : walk(p);
    return [p];
  });
}

const rel = (p: string): string => relative(ROOT, p);
const CLAUDE_FILES = walk(join(ROOT, ".claude"));

describe("structure: .claude/** names only paths that exist", () => {
  // A repo-relative path, not part of a longer path (`~/.claude/...`,
  // `research-loop/src/...`, `$DEVLOOP_DIR/src/...` are not repo-relative).
  const PATH_RE = /(?<![\w~/.<>$-])(\.claude|src|scripts|docs)\/[\w./-]+\.(md|ts|mjs|sh|json)/g;

  it("scans a non-empty .claude tree", () => {
    expect(CLAUDE_FILES.length).toBeGreaterThan(5);
  });

  it("every named path exists", () => {
    const missing: string[] = [];
    for (const f of CLAUDE_FILES) {
      for (const m of readFileSync(f, "utf8").matchAll(PATH_RE)) {
        if (!existsSync(join(ROOT, m[0]))) missing.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("structure: settings.json hooks", () => {
  it("every hook command points to an executable file", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
    expect(commands.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const command of commands) {
      const path = command.replace(/^"\$CLAUDE_PROJECT_DIR"/, ROOT);
      if (path === command) {
        bad.push(`${command}: not under "$CLAUDE_PROJECT_DIR"`);
        continue;
      }
      if (!existsSync(path) || (statSync(path).mode & 0o111) === 0) bad.push(`${command}: missing or not executable`);
    }
    expect(bad).toEqual([]);
  });
});

describe("structure: no skill hardcodes .pipeline/", () => {
  // The one allowed mention is the run-dir validation marker the skills check
  // their given run-dir= against (Ruling 23); any other `.pipeline/` is a
  // hardcoded or derived path.
  const MARKER = "`/.pipeline/v2/`";
  const skills = CLAUDE_FILES.filter((f) => /\.claude\/skills\/.+\/SKILL\.md$/.test(f));

  it("finds the three skills", () => {
    expect(skills.map(rel).sort()).toEqual([
      ".claude/skills/reset-project/SKILL.md",
      ".claude/skills/ticket-refine/SKILL.md",
      ".claude/skills/ticket-to-pr/SKILL.md",
    ]);
  });

  for (const f of skills) {
    it(`${rel(f)} has no .pipeline/ beyond the run-dir marker`, () => {
      const lines = readFileSync(f, "utf8")
        .split("\n")
        .map((l, i) => [i + 1, l.split(MARKER).join("")] as const)
        .filter(([, l]) => l.includes(".pipeline/"));
      expect(lines).toEqual([]);
    });
  }

  for (const name of ["ticket-refine", "ticket-to-pr"]) {
    it(`${name} takes run-dir= and repo-dir= and checks the marker`, () => {
      const text = readFileSync(join(ROOT, `.claude/skills/${name}/SKILL.md`), "utf8");
      expect(text).toContain("run-dir=");
      expect(text).toContain("repo-dir=");
      expect(text).toContain(MARKER);
      expect(text).toContain("Never guess a path.");
      expect(text).not.toMatch(/\bSLUG\b/);
    });
  }
});

describe("structure: agents never derive a run path", () => {
  const agents = CLAUDE_FILES.filter((f) => /\.claude\/agents\/.+\.md$/.test(f));
  it("finds the four agents", () => expect(agents.length).toBe(4));
  for (const f of agents) {
    it(`${rel(f)} has no .pipeline/ and no <SLUG>`, () => {
      const text = readFileSync(f, "utf8");
      expect(text).not.toContain(".pipeline/");
      expect(text).not.toMatch(/<SLUG>/);
    });
  }
});

describe("structure: skill prose (Ruling 24)", () => {
  const read = (name: string) => readFileSync(join(ROOT, `.claude/skills/${name}/SKILL.md`), "utf8");

  it("ticket-to-pr Phase 5 says to push with the literal branch name", () => {
    const text = read("ticket-to-pr");
    const phase5 = text.slice(text.indexOf("### Phase 5"), text.indexOf("## Cleanup"));
    expect(phase5).toContain("push with the literal branch name");
  });

  it("ticket-refine's passing-verdict Jira template does not mention Needs-decision bullets", () => {
    const text = read("ticket-refine");
    const start = text.indexOf("2. **On a passing verdict**");
    const passing = text.slice(start, text.indexOf("3. **On a bounce**", start));
    expect(start).toBeGreaterThan(-1);
    expect(passing).not.toMatch(/Needs-decision bullets/);
  });

  describe("ticket-to-pr Phase 4: failures that already exist on master (Ruling 29)", () => {
    const phase4 = () => {
      const text = read("ticket-to-pr");
      return text.slice(text.indexOf("### Phase 4"), text.indexOf("### Phase 5"));
    };

    it("re-runs the failing tests against unmodified origin/<defaultBranch> before bouncing", () => {
      expect(phase4()).toContain("Pre-existing failure check");
      expect(phase4()).toMatch(/git -C <REPO_DIR> worktree add --detach[\s\\]+\S*-baseline/);
      expect(phase4()).toContain("origin/<targetRepo.defaultBranch>");
    });

    it("proceeds only when the branch's failing set is a subset of the baseline's", () => {
      expect(phase4()).toMatch(/every test that fails on the branch also fails[^.]*on the baseline/i);
      expect(phase4()).toMatch(/fails only on the branch[^.]*Green-phase\s+defect/i);
    });

    it("names the pre-existing failures in the PR body, qa_notes and the result line", () => {
      expect(phase4()).toContain("## Pre-existing failures");
      expect(phase4()).toMatch(/pre-existing on `?origin\/<defaultBranch>`? <sha>/i);
      expect(phase4()).toContain("preexisting_failures");
    });

    it("still forbids bypassing a push hook that runs the suite", () => {
      expect(phase4()).toMatch(/never bypass[^.]*hook/i);
    });

    it("removes the baseline worktree", () => {
      expect(phase4()).toMatch(/worktree remove[^\n]*baseline/);
    });
  });

  it("no skill mentions the removed auto-promote label", () => {
    for (const name of ["ticket-refine", "ticket-to-pr"]) expect(read(name)).not.toMatch(/auto-promote|autoPromote/);
  });
});

describe("structure: no banned git/gh flags", () => {
  const BANNED = /--force|--no-verify|gh stack (push|sync|submit)/;
  // The unsafe-git checker IS the deny list: its pattern table and reason
  // strings must spell every banned flag. Exempted by exact path, nothing
  // else. Its hook tests live under test/hooks/, which is not scanned.
  const DENY_LIST = "scripts/check-unsafe-git-in-tool-input.ts";
  const files = ["src", "scripts", "evals"].flatMap((d) => walk(join(ROOT, d))).concat(CLAUDE_FILES);

  it("scans .claude, src and scripts, and exempts only the deny list", () => {
    expect(files.some((f) => rel(f).startsWith("src/"))).toBe(true);
    expect(files.some((f) => rel(f).startsWith("scripts/"))).toBe(true);
    expect(readFileSync(join(ROOT, DENY_LIST), "utf8")).toContain("Unverifiable");
  });

  it("the matcher is not a no-op", () => {
    expect(BANNED.test("git push --force-with-lease")).toBe(true);
    expect(BANNED.test("git commit --no-verify")).toBe(true);
    expect(BANNED.test("gh stack submit")).toBe(true);
    expect(BANNED.test("git push -u origin TARS-1-x")).toBe(false);
  });

  it("a line naming one also says never or banned", () => {
    const hits: string[] = [];
    for (const f of files) {
      if (rel(f) === DENY_LIST) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (BANNED.test(line) && !/never|banned/i.test(line)) hits.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("structure: research-loop/ is gone", () => {
  // Only its tracked checkout files. research-loop/runs/ may still hold
  // pre-cutover v1 logs that v1PreCutoverRunsLog reads (Ruling 28).
  it("no research-loop/.claude and no research-loop/CLAUDE.md", () => {
    expect(existsSync(join(ROOT, "research-loop/.claude"))).toBe(false);
    expect(existsSync(join(ROOT, "research-loop/CLAUDE.md"))).toBe(false);
  });

  it("the research stance file the spawn loads exists", () => {
    expect(existsSync(join(ROOT, "src/roles/research/stance.md"))).toBe(true);
  });
});
