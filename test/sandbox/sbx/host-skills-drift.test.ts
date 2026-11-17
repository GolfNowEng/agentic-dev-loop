// Drift guard: every operator skill a pipeline skill or agent READS by path
// (`~/.claude/skills/<name>/SKILL.md`) must be listed in each project's
// sandbox.sbx.hostSkills, and be passed as a `<name>=` pointer the skill
// honours. Otherwise a sandboxed run can't see it (the sandbox has no
// ~/.claude) and bounces late, as TARS-1634's dev run did at Phase 5.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const SOURCES = [
  ...readdirSync(join(ROOT, ".claude/skills")).map((d) => join(ROOT, ".claude/skills", d, "SKILL.md")),
  ...readdirSync(join(ROOT, ".claude/agents")).map((f) => join(ROOT, ".claude/agents", f)),
];
const READ = /~\/\.claude\/skills\/([A-Za-z0-9._-]+)\/SKILL\.md/g;

function readSkills(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of SOURCES) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(READ)) out.set(m[1]!, [...(out.get(m[1]!) ?? []), f.slice(ROOT.length + 1)]);
  }
  return out;
}

const sbxProjects = readdirSync(ROOT)
  .filter((f) => /^pipeline\..+\.config\.json$/.test(f))
  .map((f) => ({ f, cfg: JSON.parse(readFileSync(join(ROOT, f), "utf8")) as { sandbox?: { sbx?: { hostSkills?: string[] } } } }))
  .filter((p) => p.cfg.sandbox?.sbx !== undefined);

describe("host skills drift guard", () => {
  it("finds the push-branch read in ticket-to-pr (the guard is live)", () => {
    expect(readSkills().get("push-branch")).toContain(".claude/skills/ticket-to-pr/SKILL.md");
  });

  it("every project with an sbx block lists each operator skill the pipeline reads", () => {
    const needed = [...readSkills().keys()].sort();
    expect(sbxProjects.length).toBeGreaterThan(0);
    for (const p of sbxProjects) expect(p.cfg.sandbox!.sbx!.hostSkills ?? [], p.f).toEqual(expect.arrayContaining(needed));
  });

  it("each skill that reads an operator skill accepts its <name>= pointer", () => {
    for (const [name, files] of readSkills()) {
      for (const f of files) expect(readFileSync(join(ROOT, f), "utf8"), `${f} must accept ${name}=`).toContain(`\`${name}=\``);
    }
  });
});
