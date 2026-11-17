import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWindows } from "../../../src/core/reset/run-windows.ts";
import type { ResetCtx } from "../../../src/core/reset/context.ts";

const SLACK = 120_000;
const t = (iso: string) => Date.parse(iso);

describe("runWindows", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "reset-windows-")));
    await mkdir(join(root, "runs/v2"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ctx = (): ResetCtx => ({
    project: "proj", slug: "proj", ticket: "TARS-1", role: "all", config: null, root,
    jira: null, github: null, openPrHeads: null, git: async () => "", sandbox: null, sandboxConfig: null,
    now: () => new Date(), closeRemote: false,
  });
  const phase = (role: string, started: string, ended: string) => ({ role, started, ended });
  const rec = (ticket: string, phases: unknown[]) => JSON.stringify({ ticket, session: "s1", started: "x", ended: "x", outcome: "landed", phases });
  const runDir = async (session: string, ticket: string, name: string, lines: string[]) => {
    const d = join(root, ".pipeline/v2/proj", session, ticket, name);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "progress.jsonl"), lines.join("\n") + "\n");
  };

  it("phases in the live log and the archive make windows with 2 minutes of slack", async () => {
    await writeFile(join(root, "runs/v2/proj.jsonl"), [
      rec("TARS-1", [phase("research", "2026-11-16T10:00:00Z", "2026-11-16T10:10:00Z")]),
      rec("TARS-2", [phase("dev", "2026-11-16T11:00:00Z", "2026-11-16T11:10:00Z")]),
    ].join("\n") + "\n");
    await writeFile(join(root, "runs/v2/proj.reset-archive.jsonl"), rec("TARS-1", [phase("dev", "2026-11-15T09:00:00Z", "2026-11-15T09:30:00Z")]) + "\n");
    const w = await runWindows(ctx());
    expect(w).toEqual(expect.arrayContaining([
      { role: "research", from: t("2026-11-16T10:00:00Z"), to: t("2026-11-16T10:10:00Z") + SLACK },
      { role: "dev", from: t("2026-11-15T09:00:00Z"), to: t("2026-11-15T09:30:00Z") + SLACK },
    ]));
    expect(w).toHaveLength(2);
  });

  it("a run dir's progress.jsonl makes a window", async () => {
    await runDir("s9", "TARS-1", "dev-20261116T120000Z", [
      JSON.stringify({ ts: "2026-11-16T12:00:05Z", phase: "intake", event: "phase_start" }),
      JSON.stringify({ ts: "2026-11-16T12:20:00Z", phase: "red", event: "note" }),
    ]);
    await runDir("s9", "TARS-10", "dev-20261116T130000Z", [JSON.stringify({ ts: "2026-11-16T13:00:00Z" })]);
    expect(await runWindows(ctx())).toEqual([
      { role: "dev", from: t("2026-11-16T12:00:05Z"), to: t("2026-11-16T12:20:00Z") + SLACK },
    ]);
  });

  it("a malformed progress line is skipped", async () => {
    await runDir("s1", "TARS-1", "research-20261116T120000Z", [
      JSON.stringify({ ts: "2026-11-16T12:00:00Z" }),
      "{not json",
      JSON.stringify({ ts: "not a date" }),
      JSON.stringify({ ts: "2026-11-16T12:05:00Z" }),
      '{"ts":"2026-11-16T13:',
    ]);
    expect(await runWindows(ctx())).toEqual([
      { role: "research", from: t("2026-11-16T12:00:00Z"), to: t("2026-11-16T12:05:00Z") + SLACK },
    ]);
  });
});
