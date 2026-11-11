import { describe, it, expect, vi } from "vitest";
import { isBlockerCleared, gateTicket, type BlockerGateDeps } from "../../src/core/blocker-gate.ts";
import { StubJiraClient } from "../../src/core/jira-client.ts";
import type { ExecGhFindMergedPrFn, ExecGhPrViewFn } from "../../src/core/github-client.ts";

const REPO = "org/repo";

function deps(o: Partial<BlockerGateDeps> = {}): BlockerGateDeps {
  return {
    repo: REPO,
    findLandedPrUrl: vi.fn(async () => null),
    execGhPrView: vi.fn<ExecGhPrViewFn>(async () => JSON.stringify({ state: "OPEN", mergedAt: null })),
    execGhFindMergedPr: vi.fn<ExecGhFindMergedPrFn>(async () => null),
    defaultBranch: "main",
    mergedCache: new Map(),
    ...o,
  };
}

const merged = (url: string, baseRefName = "main") => ({ url, mergedAt: "2026-01-01T00:00:00Z", baseRefName });

describe("isBlockerCleared", () => {
  it("merged via search into the default branch -> cleared", async () => {
    const d = deps({ execGhFindMergedPr: vi.fn(async () => merged("https://github.com/org/repo/pull/5")) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(true);
    expect(r.reason).toContain("https://github.com/org/repo/pull/5");
    expect(d.execGhFindMergedPr).toHaveBeenCalledWith("TARS-1", { baseRefName: "main" });
  });

  it("recorded PR closed unmerged but search finds a merged one -> cleared", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/470"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "CLOSED", mergedAt: null })),
      execGhFindMergedPr: vi.fn(async () => merged("https://github.com/org/repo/pull/476")),
    });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(true);
    expect(r.reason).toContain("pull/476");
  });

  it("recorded PR has mergedAt (search finds nothing) -> cleared", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/9"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" })),
    });
    expect((await isBlockerCleared("TARS-1", d)).cleared).toBe(true);
  });

  it("open PR -> not cleared, reason names the PR", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/12"),
      execGhPrView: vi.fn(async () => JSON.stringify({ state: "OPEN", mergedAt: null })),
    });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r).toEqual({ cleared: false, reason: "blocker TARS-1 PR open: https://github.com/org/repo/pull/12" });
  });

  it("no PR at all -> not cleared, the needs-a-human reason", async () => {
    const r = await isBlockerCleared("TARS-1", deps());
    expect(r).toEqual({
      cleared: false,
      reason: "blocker TARS-1 has no merged PR in org/repo — needs a human (Done without a PR, or another repo)",
    });
  });

  it("gh throws -> not cleared, error in reason, redacted and capped", async () => {
    const long = "gh: HTTP 502 for someone@example.com " + "x".repeat(500);
    const d = deps({ execGhFindMergedPr: vi.fn(async () => { throw new Error(long); }) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(r.reason.startsWith("blocker TARS-1 check failed: gh: HTTP 502")).toBe(true);
    expect(r.reason).not.toContain("someone@example.com");
    expect(r.reason.length).toBeLessThanOrEqual("blocker TARS-1 check failed: ".length + 200);
  });

  it("findLandedPrUrl throws -> not cleared (fail closed)", async () => {
    const d = deps({ findLandedPrUrl: vi.fn(async () => { throw new Error("EACCES"); }) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r).toEqual({ cleared: false, reason: "blocker TARS-1 check failed: EACCES" });
  });

  it("unparseable gh pr view output -> not cleared (fail closed)", async () => {
    const d = deps({
      findLandedPrUrl: vi.fn(async () => "https://github.com/org/repo/pull/12"),
      execGhPrView: vi.fn(async () => "not json"),
    });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toMatch(/^blocker TARS-1 check failed: /);
  });

  it("a blocker from another Jira project (MC-9) is not cleared, needs a human, and gh is not called", async () => {
    const d = deps({ projectKey: "TARS", execGhFindMergedPr: vi.fn(async () => merged("u")) });
    const r = await isBlockerCleared("MC-9", d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toContain("needs a human");
    expect(r.reason).toBe("blocker MC-9 has no merged PR in org/repo — needs a human (Done without a PR, or another repo)");
    expect(d.execGhFindMergedPr).not.toHaveBeenCalled();
    expect(d.findLandedPrUrl).not.toHaveBeenCalled();
  });

  it("a merged PR into a non-default base is not cleared", async () => {
    const d = deps({ execGhFindMergedPr: vi.fn(async () => merged("https://github.com/org/repo/pull/7", "release/1.2")) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
    expect(r.reason).toContain("needs a human");
  });

  it("a cached merged result skips the gh call on the second check", async () => {
    const d = deps({ execGhFindMergedPr: vi.fn(async () => merged("https://github.com/org/repo/pull/5")) });
    expect((await isBlockerCleared("TARS-1", d)).cleared).toBe(true);
    expect(d.mergedCache.get("TARS-1")).toBe("https://github.com/org/repo/pull/5");
    const second = await isBlockerCleared("TARS-1", d);
    expect(second.cleared).toBe(true);
    expect(d.execGhFindMergedPr).toHaveBeenCalledTimes(1);
    expect(d.findLandedPrUrl).toHaveBeenCalledTimes(1);
  });

  it("failures and not-cleared results are never cached", async () => {
    const d = deps({ execGhFindMergedPr: vi.fn(async () => { throw new Error("boom"); }) });
    await isBlockerCleared("TARS-1", d);
    await isBlockerCleared("TARS-1", deps({ mergedCache: d.mergedCache }));
    expect(d.mergedCache.size).toBe(0);
  });

  it("TARS-1 vs a merged TARS-12 branch is not cleared (whole-token match, real finder)", async () => {
    const { realExecGhFindMergedPr } = await import("../../src/core/github-client.ts");
    const exec = vi.fn(async () =>
      JSON.stringify([
        { url: "u12", mergedAt: "2026-01-01T00:00:00Z", title: "TARS-12: thing", headRefName: "feature/TARS-12-thing", baseRefName: "main" },
      ]),
    );
    const d = deps({ execGhFindMergedPr: realExecGhFindMergedPr(REPO, exec) });
    const r = await isBlockerCleared("TARS-1", d);
    expect(r.cleared).toBe(false);
  });
});

describe("gateTicket", () => {
  it("two blockers, one cleared and one not -> pass:false, blockedBy:[TARS-2]", async () => {
    const jira = new StubJiraClient({ blockedBy: { "TARS-5": ["TARS-1", "TARS-2"] } });
    const d = deps({
      execGhFindMergedPr: vi.fn(async (k: string) => (k === "TARS-1" ? merged("https://github.com/org/repo/pull/1") : null)),
    });
    const r = await gateTicket("TARS-5", { ...d, jira });
    expect(r).toEqual({
      pass: false,
      blockedBy: ["TARS-2"],
      reasons: ["blocker TARS-2 has no merged PR in org/repo — needs a human (Done without a PR, or another repo)"],
    });
  });

  it("no blockers -> pass", async () => {
    const jira = new StubJiraClient({ blockedBy: {} });
    expect(await gateTicket("TARS-5", { ...deps(), jira })).toEqual({ pass: true });
  });

  it("all blockers cleared -> pass", async () => {
    const jira = new StubJiraClient({ blockedBy: { "TARS-5": ["TARS-1", "TARS-2"] } });
    const d = deps({ execGhFindMergedPr: vi.fn(async (k: string) => merged(`https://github.com/org/repo/pull/${k}`)) });
    expect(await gateTicket("TARS-5", { ...d, jira })).toEqual({ pass: true });
  });

  it("getBlockedBy throws -> fail closed (not pass), reason names the ticket", async () => {
    const jira = new StubJiraClient({ blockedBy: {} });
    jira.getBlockedBy = vi.fn(async () => { throw new Error("Jira 503"); });
    const r = await gateTicket("TARS-5", { ...deps(), jira });
    expect(r.pass).toBe(false);
    if (!r.pass) {
      expect(r.blockedBy).toEqual([]);
      expect(r.reasons).toEqual(["blockers of TARS-5 check failed: Jira 503"]);
    }
  });

  it("derives projectKey from the ticket key: a cross-project blocker is not cleared", async () => {
    const jira = new StubJiraClient({ blockedBy: { "TARS-5": ["MC-9"] } });
    const d = deps({ execGhFindMergedPr: vi.fn(async () => merged("u")) });
    const r = await gateTicket("TARS-5", { ...d, jira });
    expect(r).toEqual({
      pass: false,
      blockedBy: ["MC-9"],
      reasons: ["blocker MC-9 has no merged PR in org/repo — needs a human (Done without a PR, or another repo)"],
    });
    expect(d.execGhFindMergedPr).not.toHaveBeenCalled();
  });
});
