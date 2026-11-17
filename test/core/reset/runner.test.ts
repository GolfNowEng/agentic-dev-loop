import { describe, expect, it } from "vitest";
import { runChecklist, type RunnerIO, type RunnerOpts } from "../../../src/core/reset/runner.ts";
import type { ResetArea, ResetStep, Survey } from "../../../src/core/reset/step.ts";

// A fake step: dirty until its run() succeeds (unless `stays` keeps it dirty), then clean.
function fake(
  area: ResetArea,
  name: string,
  log: string[],
  o: { clean?: boolean; fails?: string; surveyThrows?: string; needsYou?: string; stays?: boolean } = {},
): ResetStep & { surveys: number } {
  let done = o.clean ?? false;
  const step = {
    area,
    name,
    surveys: 0,
    async survey(): Promise<Survey> {
      step.surveys++;
      if (o.surveyThrows) throw new Error(`${o.surveyThrows}\nsecond line`);
      if (o.needsYou) return { found: "x", action: null, needsYou: o.needsYou };
      if (done) return { found: "none", action: null };
      return {
        found: "1 thing",
        action: "fix",
        run: async () => {
          log.push(`${area}/${name}`);
          if (o.fails) throw new Error(o.fails);
          if (!o.stays) done = true;
        },
      };
    },
  };
  return step;
}

function io(answer: string | null = "y"): RunnerIO & { out: string[]; asked: string[] } {
  const out: string[] = [];
  const asked: string[] = [];
  return {
    out,
    asked,
    print: (s) => out.push(s),
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
  };
}

const opts = (over: Partial<RunnerOpts> = {}): RunnerOpts => ({
  title: "Reset TARS-1 (role: all)",
  ticket: "TARS-1",
  dryRun: false,
  yes: false,
  preExecuteCheck: async () => null,
  ...over,
});

describe("runChecklist", () => {
  it("dry-run prints the table and runs nothing", async () => {
    const log: string[] = [];
    const t = io();
    const code = await runChecklist([fake("local", "run records", log)], opts({ dryRun: true }), t);
    expect(code).toBe(0);
    expect(log).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.out.join("\n")).toContain("Reset TARS-1 (role: all)");
    expect(t.out.join("\n")).toContain("local  run records  1 thing  fix");
    expect(t.out.at(-1)).toBe("[reset] --dry-run: nothing changed.");
  });

  it("declined runs nothing", async () => {
    const log: string[] = [];
    const t = io("n");
    const code = await runChecklist([fake("local", "run records", log)], opts(), t);
    expect(code).toBe(0);
    expect(log).toEqual([]);
    expect(t.asked).toEqual(["Proceed? [y/N] "]);
    expect(t.out.at(-1)).toBe("[reset] declined: nothing changed.");
  });

  it("accepts YES with whitespace", async () => {
    const log: string[] = [];
    const code = await runChecklist([fake("local", "run records", log)], opts(), io("  YES \n"));
    expect(code).toBe(0);
    expect(log).toEqual(["local/run records"]);
  });

  it("no TTY without --yes runs nothing and exits 1", async () => {
    const log: string[] = [];
    const t = io(null);
    const code = await runChecklist([fake("local", "run records", log)], opts(), t);
    expect(code).toBe(1);
    expect(log).toEqual([]);
    expect(t.out.at(-1)).toBe("[reset] no terminal to ask on: rerun with --yes after reviewing the table above.");
  });

  it("--yes skips the prompt", async () => {
    const log: string[] = [];
    const t = io(null);
    expect(await runChecklist([fake("local", "run records", log)], opts({ yes: true }), t)).toBe(0);
    expect(t.asked).toEqual([]);
    expect(log).toEqual(["local/run records"]);
  });

  it("runs actions in area order", async () => {
    const log: string[] = [];
    const steps = [
      fake("jira", "status", log),
      fake("local", "run records", log),
      fake("local", "run dirs", log),
      fake("sandbox", "leftover sandboxes", log),
      fake("git", "worktrees", log),
    ];
    expect(await runChecklist(steps, opts({ yes: true }), io())).toBe(0);
    expect(log).toEqual(["sandbox/leftover sandboxes", "git/worktrees", "local/run records", "local/run dirs", "jira/status"]);
  });

  it("a failing run doesn't stop the rest", async () => {
    const log: string[] = [];
    const steps = [fake("git", "worktrees", log, { fails: "boom" }), fake("local", "run records", log)];
    const t = io();
    const code = await runChecklist(steps, opts({ yes: true }), t);
    expect(code).toBe(1);
    expect(log).toEqual(["git/worktrees", "local/run records"]);
    const all = t.out.join("\n");
    expect(all).toContain("Ran");
    expect(all).toMatch(/git\s+worktrees\s+1 thing\s+failed: boom/);
    expect(all).toMatch(/local\s+run records\s+1 thing\s+done/);
  });

  it("a throwing survey becomes a needs-you row", async () => {
    const log: string[] = [];
    const steps = [fake("jira", "status", log, { surveyThrows: "401 Unauthorized" }), fake("local", "run records", log)];
    const t = io();
    const code = await runChecklist(steps, opts({ yes: true }), t);
    expect(code).toBe(1);
    expect(log).toEqual(["local/run records"]);
    expect(t.out[0]).toMatch(/jira\s+status\s+-\s+needs you: 401 Unauthorized$/m);
    expect(t.out.join("\n")).not.toContain("second line");
  });

  it("re-checks the live worker after approval", async () => {
    const log: string[] = [];
    const t = io("y");
    const msg = "[reset] refusing: a live worker holds /x/dev-1.lock. Stop it first, or pass --ignore-live-worker.";
    const code = await runChecklist([fake("local", "run records", log)], opts({ preExecuteCheck: async () => msg }), t);
    expect(code).toBe(1);
    expect(log).toEqual([]);
    expect(t.out.at(-1)).toBe(msg);
  });

  it("exits 0 only when the re-survey is at zero", async () => {
    const log: string[] = [];
    const t = io();
    const code = await runChecklist([fake("local", "run records", log), fake("git", "worktrees", log)], opts({ yes: true }), t);
    expect(code).toBe(0);
    expect(t.out.join("\n")).toContain("After reset");
    expect(t.out.at(-1)).toBe("[reset] TARS-1 is at zero.");
  });

  it("a run that leaves the row dirty is not at zero", async () => {
    const log: string[] = [];
    const t = io();
    const code = await runChecklist([fake("local", "run records", log, { stays: true })], opts({ yes: true }), t);
    expect(code).toBe(1);
    expect(t.out.at(-2)).toBe("[reset] TARS-1 is not at zero: 1 step(s) need you:");
    expect(t.out.at(-1)).toBe("  - local run records: still to do: fix");
  });

  it("lists the steps that need you and exits 1", async () => {
    const log: string[] = [];
    const steps = [
      fake("local", "run records", log),
      fake("jira", "status", log, { needsYou: "no credentials" }),
      fake("github", "mirror Issue", log, { needsYou: "no credentials" }),
    ];
    const t = io();
    const code = await runChecklist(steps, opts({ yes: true }), t);
    expect(code).toBe(1);
    expect(log).toEqual(["local/run records"]);
    expect(t.out.slice(-3)).toEqual([
      "[reset] TARS-1 is not at zero: 2 step(s) need you:",
      "  - jira status: no credentials",
      "  - github mirror Issue: no credentials",
    ]);
  });

  it("already at zero skips the prompt", async () => {
    const log: string[] = [];
    const t = io();
    const code = await runChecklist([fake("local", "run records", log, { clean: true })], opts(), t);
    expect(code).toBe(0);
    expect(t.asked).toEqual([]);
    expect(t.out.at(-1)).toBe("[reset] TARS-1 is already at zero.");
  });

  it("R2: a failed run is listed as needing you even when the re-survey is clean", async () => {
    const log: string[] = [];
    // Fails, yet the re-survey reads clean (e.g. the thing went away on its own).
    let n = 0;
    const flaky: ResetStep = {
      area: "git",
      name: "worktrees",
      async survey() {
        n++;
        if (n > 1) return { found: "none", action: null };
        return { found: "1", action: "remove", run: async () => { throw new Error("git said no"); } };
      },
    };
    const t = io();
    const code = await runChecklist([flaky, fake("local", "run records", log)], opts({ yes: true }), t);
    expect(code).toBe(1);
    expect(t.out.slice(-2)).toEqual([
      "[reset] TARS-1 is not at zero: 1 step(s) need you:",
      "  - git worktrees: failed: git said no",
    ]);
    const after = t.out.find((s) => s.startsWith("After reset"))!;
    expect(after).toMatch(/git\s+worktrees\s+none\s+failed: git said no/);
  });

  it("R10: verify re-surveys the same step instances", async () => {
    const log: string[] = [];
    const a = fake("local", "run records", log);
    const b = fake("jira", "status", log, { needsYou: "no credentials" });
    await runChecklist([a, b], opts({ yes: true }), io());
    expect(a.surveys).toBe(2);
    expect(b.surveys).toBe(2);
  });

  it("never runs a needs-you row or a row with no run", async () => {
    const log: string[] = [];
    const ran: string[] = [];
    const sneaky: ResetStep = {
      area: "local",
      name: "x",
      async survey() {
        return { found: "f", action: "do it", needsYou: "unsafe", run: async () => { ran.push("x"); } };
      },
    };
    await runChecklist([sneaky, fake("git", "worktrees", log)], opts({ yes: true }), io());
    expect(ran).toEqual([]);
  });

  describe("a step that makes the ticket pollable", () => {
    const pollable = (log: string[]): ResetStep & { surveys: number } => Object.assign(fake("jira", "status", log), { makesPollable: true });

    it("is held while another row needs you, and the table says so before the prompt", async () => {
      const log: string[] = [];
      const o = io();
      const code = await runChecklist(
        [fake("local", "run records", log), pollable(log), fake("github", "mirror Issue", log, { needsYou: "close #590 as not planned" })],
        opts(),
        o,
      );
      expect(log).toEqual(["local/run records"]);
      // The note may wrap in a narrow table: compare with the spacing collapsed.
      expect(o.out[0]!.replace(/\s+/g, " ")).toContain("↳ held until the rows that need you are clean");
      expect(o.out.join("\n")).toContain("jira status: failed: held: github mirror Issue needs you");
      expect(code).toBe(1);
    });

    it("is held when an earlier run failed", async () => {
      const log: string[] = [];
      const code = await runChecklist([fake("git", "worktrees", log, { fails: "nope" }), pollable(log)], opts({ yes: true }), io());
      expect(log).toEqual(["git/worktrees"]);
      expect(code).toBe(1);
    });

    it("is held when another row's survey threw", async () => {
      const log: string[] = [];
      await runChecklist([fake("sandbox", "leftover sandboxes", log, { surveyThrows: "sbx down" }), pollable(log)], opts({ yes: true }), io());
      expect(log).toEqual([]);
    });

    it("runs last when everything else is clean or done", async () => {
      const log: string[] = [];
      const code = await runChecklist(
        [pollable(log), fake("github", "x", log), fake("local", "run records", log), fake("sandbox", "s", log, { clean: true })],
        opts({ yes: true }),
        io(),
      );
      expect(log).toEqual(["local/run records", "github/x", "jira/status"]);
      expect(code).toBe(0);
    });
  });
});

