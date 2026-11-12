import { describe, expect, it, vi } from "vitest";
import { notify } from "../../src/core/notify.ts";

const FAKE_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("notify (desktop notification)", () => {
  it("builds the expected osascript argv with escaped quotes", () => {
    const exec = vi.fn();
    notify('dev-loop: "TARS-1" parked', 'refused a\\b "x"', exec, "darwin");
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe("osascript");
    expect(args).toEqual(["-e", 'display notification "refused a\\\\b \\"x\\"" with title "dev-loop: \\"TARS-1\\" parked"']);
  });

  it("redacts the title and body", () => {
    const exec = vi.fn();
    notify(`t ${FAKE_TOKEN}`, `b ${FAKE_TOKEN}`, exec, "darwin");
    expect(JSON.stringify(exec.mock.calls[0])).not.toContain(FAKE_TOKEN);
  });

  it("is a no-op when the platform isn't darwin", () => {
    const exec = vi.fn();
    notify("t", "b", exec, "linux");
    expect(exec).not.toHaveBeenCalled();
  });

  it("swallows an exec error", () => {
    const exec = vi.fn(() => {
      throw new Error("osascript missing");
    });
    expect(() => notify("t", "b", exec, "darwin")).not.toThrow();
  });

  it("swallows an async exec error reported through the callback", () => {
    const exec = vi.fn((_c: string, _a: string[], cb?: (err: Error | null) => void) => cb?.(new Error("exit 1")));
    expect(() => notify("t", "b", exec, "darwin")).not.toThrow();
  });
});
