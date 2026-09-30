import { describe, it, expect, vi } from "vitest";
import { parseQaBrowserArgs, runQaBrowser, type BrowserLauncher } from "../src/qa-browser.ts";

describe("parseQaBrowserArgs", () => {
  it("parses url and out with defaults", () => {
    const a = parseQaBrowserArgs(["--url", "http://localhost:3000/x", "--out", "/tmp/a.png"]);
    expect(a).toMatchObject({ url: "http://localhost:3000/x", out: "/tmp/a.png", steps: [] });
    expect(a.width).toBe(1280);
    expect(a.height).toBe(800);
  });

  it("parses repeatable --click and --wait-for steps in order", () => {
    const a = parseQaBrowserArgs([
      "--url", "http://localhost:3000", "--out", "/tmp/a.png",
      "--click", "text=Posts", "--wait-for", ".list", "--click", "#more",
    ]);
    expect(a.steps).toEqual([
      { kind: "click", selector: "text=Posts" },
      { kind: "waitFor", selector: ".list" },
      { kind: "click", selector: "#more" },
    ]);
  });

  it("rejects a missing --url or --out", () => {
    expect(() => parseQaBrowserArgs(["--out", "/tmp/a.png"])).toThrow(/--url/);
    expect(() => parseQaBrowserArgs(["--url", "http://localhost:3000"])).toThrow(/--out/);
  });

  it("only allows localhost urls, so QA cannot wander onto real environments", () => {
    expect(() => parseQaBrowserArgs(["--url", "https://example.com", "--out", "/tmp/a.png"])).toThrow(/localhost/);
    expect(parseQaBrowserArgs(["--url", "http://127.0.0.1:5173", "--out", "/tmp/a.png"]).url).toBe("http://127.0.0.1:5173");
  });

  it("rejects unknown flags rather than ignoring them", () => {
    expect(() => parseQaBrowserArgs(["--url", "http://localhost:3000", "--out", "/tmp/a.png", "--bogus", "1"])).toThrow(/--bogus/);
  });
});

function fakeLauncher() {
  const page = {
    on: vi.fn(),
    goto: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {}),
    screenshot: vi.fn(async () => {}),
  };
  const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
  const launch: BrowserLauncher = vi.fn(async () => browser);
  return { page, browser, launch };
}

describe("runQaBrowser", () => {
  const args = parseQaBrowserArgs([
    "--url", "http://localhost:3000", "--out", "/tmp/a.png", "--click", "text=Posts", "--wait-for", ".list",
  ]);

  it("navigates, runs steps in order, screenshots, and closes the browser", async () => {
    const { page, browser, launch } = fakeLauncher();
    const result = await runQaBrowser(args, launch);
    expect(page.goto).toHaveBeenCalledWith("http://localhost:3000", expect.anything());
    expect(page.click).toHaveBeenCalledWith("text=Posts");
    expect(page.waitForSelector).toHaveBeenCalledWith(".list", expect.anything());
    expect(page.screenshot).toHaveBeenCalledWith({ path: "/tmp/a.png", fullPage: true });
    expect(browser.close).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.screenshot).toBe("/tmp/a.png");
  });

  it("collects console messages and page errors into the result", async () => {
    const { page, launch } = fakeLauncher();
    page.on.mockImplementation((evt: string, cb: (x: unknown) => void) => {
      if (evt === "console") cb({ type: () => "error", text: () => "boom" });
      if (evt === "pageerror") cb(new Error("uncaught"));
    });
    const result = await runQaBrowser(args, launch);
    expect(result.console).toContainEqual({ type: "error", text: "boom" });
    expect(result.pageErrors).toEqual(["uncaught"]);
  });

  it("closes the browser and reports the failure when a step throws", async () => {
    const { page, browser, launch } = fakeLauncher();
    page.click.mockRejectedValue(new Error("selector not found"));
    const result = await runQaBrowser(args, launch);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/selector not found/);
    expect(browser.close).toHaveBeenCalled();
  });

  it("reports playwright-unavailable as unverified instead of throwing", async () => {
    const launch: BrowserLauncher = async () => {
      throw new Error("Executable doesn't exist at /x/chromium");
    };
    const result = await runQaBrowser(args, launch);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/npm run setup-qa/);
  });
});
