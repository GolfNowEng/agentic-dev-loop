import { describe, expect, it } from "vitest";
import { makeSbxAdapter } from "../../../src/sandbox/sbx/adapter.ts";
import { dashboardCommand, openSbxDashboard, type DashboardDeps } from "../../../src/sandbox/sbx/dashboard.ts";

function deps(over: Partial<DashboardDeps> = {}): DashboardDeps & { calls: { cmd: string; args: string[] }[]; logs: string[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const logs: string[] = [];
  return {
    platform: "darwin",
    interactive: true,
    alreadyOpen: () => false,
    exec: (cmd, args) => {
      calls.push({ cmd, args });
    },
    log: (m) => logs.push(m),
    calls,
    logs,
    ...over,
  };
}

describe("dashboardCommand", () => {
  it("cds into the repo root (single-quoted) and runs the npm dashboard script", () => {
    expect(dashboardCommand("/Users/me/Desktop/Repos/dev-loop")).toBe("cd '/Users/me/Desktop/Repos/dev-loop' && npm run sbx:dashboard");
  });
  it("escapes a single quote in the path", () => {
    expect(dashboardCommand("/a/it's")).toBe("cd '/a/it'\\''s' && npm run sbx:dashboard");
  });
});

describe("openSbxDashboard", () => {
  it("opens a new Terminal window via osascript, passing the command as an argument (not spliced into the script)", () => {
    const d = deps();
    expect(openSbxDashboard("/r/dev-loop", d)).toBe("opened");
    expect(d.calls).toHaveLength(1);
    const { cmd, args } = d.calls[0];
    expect(cmd).toBe("osascript");
    expect(args.at(-1)).toBe("cd '/r/dev-loop' && npm run sbx:dashboard");
    expect(args.slice(0, -1).join(" ")).not.toContain("/r/dev-loop");
    expect(args.join(" ")).toContain('tell application "Terminal" to do script (item 1 of argv)');
    expect(d.logs.join("\n")).toContain("opened the sbx dashboard");
  });

  it("skips when not on macOS, printing the manual command", () => {
    const d = deps({ platform: "linux" });
    expect(openSbxDashboard("/r", d)).toBe("skipped");
    expect(d.calls).toHaveLength(0);
    expect(d.logs.join("\n")).toContain("npm run sbx:dashboard");
  });

  it("skips when not interactive (no terminal: an agent, a pipe, a background run)", () => {
    const d = deps({ interactive: false });
    expect(openSbxDashboard("/r", d)).toBe("skipped");
    expect(d.calls).toHaveLength(0);
  });

  it("skips when a dashboard is already open", () => {
    const d = deps({ alreadyOpen: () => true });
    expect(openSbxDashboard("/r", d)).toBe("skipped");
    expect(d.calls).toHaveLength(0);
    expect(d.logs.join("\n")).toContain("already open");
  });

  it("never throws: a failed osascript is logged with the manual command", () => {
    const d = deps({
      exec: () => {
        throw new Error("not authorized");
      },
    });
    expect(openSbxDashboard("/r", d)).toBe("failed");
    expect(d.logs.join("\n")).toMatch(/not authorized[\s\S]*npm run sbx:dashboard/);
  });
});

describe("sbx adapter onRunStart", () => {
  const adapter = (d: DashboardDeps) =>
    makeSbxAdapter({ run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), dashboardDeps: () => d });

  it("opens the dashboard", () => {
    const d = deps();
    adapter(d).onRunStart?.({ repoRoot: "/r", dashboard: true, log: () => {} });
    expect(d.calls.map((c) => c.cmd)).toEqual(["osascript"]);
  });

  it("does nothing with --no-dashboard", () => {
    const d = deps();
    adapter(d).onRunStart?.({ repoRoot: "/r", dashboard: false, log: () => {} });
    expect(d.calls).toHaveLength(0);
  });
});
