/**
 * The one sanctioned way for qa-agent to look at a running app in a browser.
 *
 *   node src/qa-browser.ts --url http://localhost:3000/path --out /tmp/x.png
 *        [--click <selector>]... [--wait-for <selector>]... [--width N --height N]
 *
 * Playwright is a pinned devDependency of THIS repo (run `npm run setup-qa`
 * once to fetch the matching Chromium), so the target repo's worktree never
 * needs it and the agent never has to install anything mid-run. Prints one
 * JSON result line to stdout. Localhost only.
 */

export type Step = { kind: "click" | "waitFor"; selector: string };

export interface QaBrowserArgs {
  url: string;
  out: string;
  steps: Step[];
  width: number;
  height: number;
}

export interface QaBrowserResult {
  ok: boolean;
  screenshot?: string;
  console: { type: string; text: string }[];
  pageErrors: string[];
  error?: string;
}

interface PageLike {
  on(evt: string, cb: (x: any) => void): void;
  goto(url: string, opts?: unknown): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  waitForSelector(selector: string, opts?: unknown): Promise<unknown>;
  screenshot(opts: { path: string; fullPage: boolean }): Promise<unknown>;
}
interface BrowserLike {
  newPage(opts?: unknown): Promise<PageLike>;
  close(): Promise<unknown>;
}
export type BrowserLauncher = () => Promise<BrowserLike>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseQaBrowserArgs(argv: string[]): QaBrowserArgs {
  let url: string | undefined;
  let out: string | undefined;
  let width = 1280;
  let height = 800;
  const steps: Step[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (val === undefined) throw new Error(`missing value for ${flag}`);
    switch (flag) {
      case "--url": url = val; break;
      case "--out": out = val; break;
      case "--click": steps.push({ kind: "click", selector: val }); break;
      case "--wait-for": steps.push({ kind: "waitFor", selector: val }); break;
      case "--width": width = Number(val); break;
      case "--height": height = Number(val); break;
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!url) throw new Error("--url is required");
  if (!out) throw new Error("--out is required");
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) {
    throw new Error(`--url must be localhost (got ${url})`);
  }
  return { url, out, steps, width, height };
}

export async function runQaBrowser(
  args: QaBrowserArgs,
  launch: BrowserLauncher,
): Promise<QaBrowserResult> {
  const result: QaBrowserResult = { ok: false, console: [], pageErrors: [] };
  let browser: BrowserLike;
  try {
    browser = await launch();
  } catch (err) {
    result.error =
      `browser unavailable (${(err as Error).message}). Report the criterion as ` +
      `"unverified" -- do not install anything. A human fixes this with: npm run setup-qa`;
    return result;
  }
  try {
    const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
    page.on("console", (m) => result.console.push({ type: m.type(), text: m.text() }));
    page.on("pageerror", (e) => result.pageErrors.push(e.message));
    await page.goto(args.url, { waitUntil: "networkidle", timeout: 30_000 });
    for (const step of args.steps) {
      if (step.kind === "click") await page.click(step.selector);
      else await page.waitForSelector(step.selector, { timeout: 15_000 });
    }
    await page.screenshot({ path: args.out, fullPage: true });
    result.ok = true;
    result.screenshot = args.out;
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    await browser.close();
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseQaBrowserArgs(process.argv.slice(2));
    const launch: BrowserLauncher = async () => {
      const { chromium } = await import("playwright");
      return (await chromium.launch()) as unknown as BrowserLike;
    };
    const result = await runQaBrowser(args, launch);
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, console: [], pageErrors: [], error: (err as Error).message }));
    process.exit(2);
  }
}
