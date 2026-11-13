import { mkdtemp, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendIteration,
  countPhaseRunsToday,
  failedAttempts,
  findLandedPrUrlAcross,
  findLandedTicketsAcross,
  findRecordedPrUrlAcross,
  hasLandedPhase,
  hasLandedV1,
  lastSkipBlockers,
  readIterations,
  readIterationsDetailed,
  recentlyEnded,
  resolveV1RunsLog,
  type IterationRecord,
  type PhaseEntry,
} from "../../src/core/iteration-log.ts";

const FAKE_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function phase(over: Partial<PhaseEntry> = {}): PhaseEntry {
  return {
    role: "dev", skill: "ticket-to-pr", skill_version: "2.0.0", model: "m",
    started: "2026-11-10T10:00:00.000Z", ended: "2026-11-10T10:05:00.000Z",
    outcome: "landed", phase_reached: "pr", cost_usd: 1, tokens: { in: 1, out: 2 },
    failure_category: null, detail: "ok", pr: "https://github.com/o/r/pull/1", run_dir: "d",
    ...over,
  };
}
function rec(over: Partial<IterationRecord> = {}): IterationRecord {
  return {
    ticket: "TARS-1", session: "s1", loop_version: "2.0.0",
    started: "2026-11-10T10:00:00.000Z", ended: "2026-11-10T10:05:00.000Z",
    outcome: "landed", phases: [phase()], ...over,
  };
}
async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "iterlog-"));
}

describe("appendIteration / readIterations", () => {
  it("round-trips, creating the directory", async () => {
    const f = join(await tmp(), "a", "b", "log.jsonl");
    const r = rec();
    await appendIteration(f, r);
    expect(await readIterations(f)).toEqual([r]);
  });

  it("is append-only: existing bytes unchanged after a second append", async () => {
    const f = join(await tmp(), "log.jsonl");
    await appendIteration(f, rec());
    const before = await readFile(f, "utf8");
    await appendIteration(f, rec({ ticket: "TARS-2" }));
    const after = await readFile(f, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split("\n")).toHaveLength(2);
  });

  it("missing file -> []", async () => {
    expect(await readIterations(join(await tmp(), "nope.jsonl"))).toEqual([]);
  });

  it("rejects a bad ticket or session without writing", async () => {
    const f = join(await tmp(), "log.jsonl");
    await expect(appendIteration(f, rec({ ticket: "../x" }))).rejects.toThrow();
    await expect(appendIteration(f, rec({ session: "BAD SESSION" }))).rejects.toThrow();
    expect(await readIterations(f)).toEqual([]);
  });

  it("redacts detail and jira_sync_error at record and phase level", async () => {
    const f = join(await tmp(), "log.jsonl");
    await appendIteration(
      f,
      rec({
        detail: `rec ${FAKE_TOKEN}`,
        phases: [phase({ detail: `ph TOKEN=${FAKE_TOKEN}`, jira_sync_error: `err ${FAKE_TOKEN}` })],
      }),
    );
    const raw = await readFile(f, "utf8");
    expect(raw).not.toContain(FAKE_TOKEN);
    expect(raw).toContain("REDACTED");
    const withSync = rec({ jira_sync_error: undefined });
    expect(withSync.ticket).toBe("TARS-1");
  });

  it("appendIteration redacts parked.approveHint and denial targets", async () => {
    const f = join(await tmp(), "log.jsonl");
    await appendIteration(
      f,
      rec({
        outcome: "parked",
        phases: [],
        resume: "dev",
        parked: {
          role: "dev",
          failure_category: "sandbox_denied",
          denied: [
            { kind: "credential", target: `token ${FAKE_TOKEN}` },
            { kind: "network", target: "api.example.com" },
          ],
          approveHint: `allow --token=${FAKE_TOKEN}`,
          cost_usd: 0.5,
          run_dir: "d",
        },
      }),
    );
    const raw = await readFile(f, "utf8");
    expect(raw).not.toContain(FAKE_TOKEN);
    const [r] = await readIterations(f);
    expect(r.parked!.approveHint).toContain("REDACTED");
    expect(r.parked!.denied[0].target).toContain("REDACTED");
    expect(r.parked!.denied[1]).toEqual({ kind: "network", target: "api.example.com" });
    expect(r.parked).toMatchObject({ role: "dev", failure_category: "sandbox_denied", cost_usd: 0.5, run_dir: "d" });
  });

  it("skips blank lines and a truncated final line", async () => {
    const f = join(await tmp(), "log.jsonl");
    await appendIteration(f, rec());
    await appendFile(f, `\n   \n${JSON.stringify(rec({ ticket: "TARS-2" })).slice(0, 30)}`);
    const out = await readIterations(f);
    expect(out.map((r) => r.ticket)).toEqual(["TARS-1"]);
  });

  it("skips and counts a malformed middle line; skips bad ticket keys", async () => {
    const f = join(await tmp(), "log.jsonl");
    await writeFile(
      f,
      [
        JSON.stringify(rec()),
        "{not json",
        JSON.stringify(rec({ ticket: "lowercase-1" })),
        JSON.stringify(rec({ ticket: "TARS-3" })),
      ].join("\n") + "\n",
    );
    const { records, skipped } = await readIterationsDetailed(f);
    expect(records.map((r) => r.ticket)).toEqual(["TARS-1", "TARS-3"]);
    expect(skipped).toBe(2);
    expect((await readIterations(f)).length).toBe(2);
  });
});

describe("countPhaseRunsToday", () => {
  it("counts per role by phase started on the UTC day; ignores yesterday and phase-less", async () => {
    const f = join(await tmp(), "log.jsonl");
    const now = new Date("2026-11-10T23:00:00Z");
    await appendIteration(f, rec({ phases: [phase(), phase({ role: "research", skill: "ticket-refine" })] }));
    await appendIteration(f, rec({ ticket: "TARS-2", phases: [phase({ started: "2026-11-09T23:59:59Z" })] }));
    await appendIteration(f, rec({ ticket: "TARS-3", outcome: "skipped-blocked", phases: [] }));
    expect(await countPhaseRunsToday(f, "dev", now)).toBe(1);
    expect(await countPhaseRunsToday(f, "research", now)).toBe(1);
  });
});

describe("hasLandedPhase / failedAttempts", () => {
  it("hasLandedPhase only for landed entry of that role", () => {
    const rs = [rec({ phases: [phase({ role: "research", outcome: "landed" }), phase({ outcome: "error" })] })];
    expect(hasLandedPhase(rs, "TARS-1", "research")).toBe(true);
    expect(hasLandedPhase(rs, "TARS-1", "dev")).toBe(false);
    expect(hasLandedPhase(rs, "TARS-9", "research")).toBe(false);
  });

  it("failedAttempts counts error/killed since last landed/bounced, per role", () => {
    const e = (outcome: PhaseEntry["outcome"], role: PhaseEntry["role"] = "dev", n = 0) =>
      rec({
        ended: `2026-11-10T1${n}:00:00Z`,
        phases: [phase({ outcome, role, started: `2026-11-10T1${n}:00:00Z`, ended: `2026-11-10T1${n}:01:00Z` })],
      });
    const rs = [e("error", "dev", 1), e("killed", "dev", 2), e("bounced", "dev", 3), e("error", "dev", 4), e("killed", "dev", 5), e("error", "research", 6)];
    expect(failedAttempts(rs, "TARS-1", "dev")).toBe(2);
    expect(failedAttempts([...rs, e("landed", "dev", 7)], "TARS-1", "dev")).toBe(0);
    expect(failedAttempts(rs, "TARS-1", "research")).toBe(1);
    expect(failedAttempts(rs, "TARS-2", "dev")).toBe(0);
  });

  it("failedAttempts ignores parked records", () => {
    const err = rec({ ended: "2026-11-10T11:00:00Z", phases: [phase({ outcome: "error", started: "2026-11-10T11:00:00Z" })] });
    const parked = (n: number) =>
      rec({
        ended: `2026-11-10T1${n}:00:00Z`,
        outcome: "parked",
        phases: [],
        resume: "dev",
        parked: { role: "dev", failure_category: "sandbox_denied", denied: [{ kind: "network", target: "x.example" }], cost_usd: 1, run_dir: "d" },
      });
    expect(failedAttempts([err, parked(2), parked(3), parked(4)], "TARS-1", "dev")).toBe(1);
    expect(failedAttempts([parked(2)], "TARS-1", "dev")).toBe(0);
  });
});

describe("recentlyEnded / lastSkipBlockers", () => {
  it("respects the window", () => {
    const now = new Date("2026-11-10T11:00:00Z");
    const rs = [rec({ ended: "2026-11-10T10:50:00Z" }), rec({ ticket: "TARS-2", ended: "2026-11-10T08:00:00Z" })];
    expect([...recentlyEnded(rs, now, 30 * 60_000)]).toEqual(["TARS-1"]);
  });

  it("lastSkipBlockers returns blocked_by only if the latest record is skipped-blocked", () => {
    const skip = rec({ outcome: "skipped-blocked", phases: [], blocked_by: ["TARS-9"], ended: "2026-11-10T12:00:00Z" });
    expect(lastSkipBlockers([rec(), skip], "TARS-1")).toEqual(["TARS-9"]);
    expect(lastSkipBlockers([skip, rec({ ended: "2026-11-10T13:00:00Z" })], "TARS-1")).toBeNull();
    expect(lastSkipBlockers([], "TARS-1")).toBeNull();
  });
});

describe("landed lookups across v1/v2", () => {
  async function fixture(v1?: object[], v2?: IterationRecord[]): Promise<string> {
    const root = await tmp();
    if (v1) {
      await mkdir(join(root, "runs/v1/dev"), { recursive: true });
      await writeFile(join(root, "runs/v1/dev/proj.jsonl"), v1.map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    if (v2) {
      await mkdir(join(root, "runs/v2"), { recursive: true });
      await writeFile(join(root, "runs/v2/proj.jsonl"), v2.map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    return root;
  }
  const v1line = (ticket: string, pr: string | null, outcome = "landed") => ({
    ticket, outcome, pr, started: "2026-11-01T00:00:00Z", ended: "2026-11-01T00:05:00Z",
  });

  it("v1 only", async () => {
    const root = await fixture([v1line("TARS-1", "https://x/pull/1"), v1line("TARS-2", null), v1line("TARS-3", "https://x/pull/3", "bounced")]);
    expect(await findLandedPrUrlAcross("proj", "TARS-1", root)).toBe("https://x/pull/1");
    expect(await findLandedPrUrlAcross("proj", "TARS-2", root)).toBeNull();
    expect((await findLandedTicketsAcross("proj", root)).map((t) => [t.ticket, t.source])).toEqual([["TARS-1", "v1"]]);
  });

  it("v2 only: latest dev landed entry with pr", async () => {
    const root = await fixture(undefined, [
      rec({ ended: "2026-11-10T10:00:00Z", phases: [phase({ pr: "https://x/pull/old" })] }),
      rec({ ended: "2026-11-10T12:00:00Z", phases: [phase({ pr: "https://x/pull/new" })] }),
      rec({ ended: "2026-11-10T13:00:00Z", outcome: "error", phases: [phase({ outcome: "error", pr: null })] }),
    ]);
    expect(await findLandedPrUrlAcross("proj", "TARS-1", root)).toBe("https://x/pull/new");
    expect(await findLandedPrUrlAcross("proj", "TARS-7", root)).toBeNull();
  });

  it("both: v2 wins per ticket; union de-duped", async () => {
    const root = await fixture(
      [v1line("TARS-1", "https://x/pull/v1"), v1line("TARS-5", "https://x/pull/5")],
      [rec({ phases: [phase({ pr: "https://x/pull/v2" })] })],
    );
    expect(await findLandedPrUrlAcross("proj", "TARS-1", root)).toBe("https://x/pull/v2");
    const all = await findLandedTicketsAcross("proj", root);
    expect(all.map((t) => [t.ticket, t.pr, t.source]).sort()).toEqual([
      ["TARS-1", "https://x/pull/v2", "v2"],
      ["TARS-5", "https://x/pull/5", "v1"],
    ]);
  });

  it("neither log -> null / []", async () => {
    const root = await tmp();
    expect(await findLandedPrUrlAcross("proj", "TARS-1", root)).toBeNull();
    expect(await findLandedTicketsAcross("proj", root)).toEqual([]);
  });
});

describe("v1 log layouts: post-cutover runs/v1/<role>/ first, else the pre-cutover live logs", () => {
  async function write(root: string, rel: string, lines: object[]): Promise<void> {
    const f = join(root, rel);
    await mkdir(join(f, ".."), { recursive: true });
    await writeFile(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  const landed = (ticket: string, pr: string | null) => ({ ticket, outcome: "landed", pr, ended: "2026-11-01T00:05:00Z" });

  it("resolveV1RunsLog: null when neither layout exists", async () => {
    const root = await tmp();
    expect(await resolveV1RunsLog("dev", "proj", root)).toBeNull();
    expect(await resolveV1RunsLog("research", "proj", root)).toBeNull();
  });

  it("resolveV1RunsLog: pre-cutover dev = runs/<slug>.jsonl, research = research-loop/runs/<slug>.jsonl", async () => {
    const root = await tmp();
    await write(root, "runs/proj.jsonl", [landed("TARS-1", "https://x/pull/1")]);
    await write(root, "research-loop/runs/proj.jsonl", [landed("TARS-2", null)]);
    expect(await resolveV1RunsLog("dev", "proj", root)).toEqual({ path: join(root, "runs/proj.jsonl"), layout: "pre-cutover" });
    expect(await resolveV1RunsLog("research", "proj", root)).toEqual({
      path: join(root, "research-loop/runs/proj.jsonl"),
      layout: "pre-cutover",
    });
  });

  it("resolveV1RunsLog: post-cutover wins when both exist", async () => {
    const root = await tmp();
    await write(root, "runs/proj.jsonl", [landed("TARS-1", "https://x/pull/old")]);
    await write(root, "runs/v1/dev/proj.jsonl", [landed("TARS-1", "https://x/pull/new")]);
    expect(await resolveV1RunsLog("dev", "proj", root)).toEqual({ path: join(root, "runs/v1/dev/proj.jsonl"), layout: "post-cutover" });
    expect(await findLandedPrUrlAcross("proj", "TARS-1", root)).toBe("https://x/pull/new");
  });

  it("findLandedPrUrlAcross / findLandedTicketsAcross fall back to the pre-cutover dev log", async () => {
    const root = await tmp();
    await write(root, "runs/proj.jsonl", [landed("TARS-1", "https://x/pull/1")]);
    expect(await findLandedPrUrlAcross("proj", "TARS-1", root)).toBe("https://x/pull/1");
    expect((await findLandedTicketsAcross("proj", root)).map((t) => [t.ticket, t.source])).toEqual([["TARS-1", "v1"]]);
  });

  it("hasLandedV1 reads the role's resolved v1 log", async () => {
    const root = await tmp();
    await write(root, "research-loop/runs/proj.jsonl", [landed("TARS-2", null), { ticket: "TARS-3", outcome: "bounced", pr: null }]);
    expect(await hasLandedV1("research", "proj", "TARS-2", root)).toBe(true);
    expect(await hasLandedV1("research", "proj", "TARS-3", root)).toBe(false);
    expect(await hasLandedV1("dev", "proj", "TARS-2", root)).toBe(false);
  });

  it("findRecordedPrUrlAcross: any recorded PR (landed or bounced), v2 first, else v1 dev", async () => {
    const root = await tmp();
    await write(root, "runs/proj.jsonl", [{ ticket: "TARS-5", outcome: "bounced", pr: "https://x/pull/5" }, landed("TARS-1", "https://x/pull/v1")]);
    await mkdir(join(root, "runs/v2"), { recursive: true });
    await writeFile(
      join(root, "runs/v2/proj.jsonl"),
      JSON.stringify(rec({ outcome: "bounced", phases: [phase({ outcome: "bounced", pr: "https://x/pull/v2" })] })) + "\n",
    );
    expect(await findRecordedPrUrlAcross("proj", "TARS-1", root)).toBe("https://x/pull/v2");
    expect(await findRecordedPrUrlAcross("proj", "TARS-5", root)).toBe("https://x/pull/5");
    expect(await findRecordedPrUrlAcross("proj", "TARS-9", root)).toBeNull();
  });
});
