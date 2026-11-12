// scripts/relabel-v1-refined.mjs driven as a subprocess against a local stub
// Jira (http.createServer on 127.0.0.1) and a temp config root.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "../../scripts/relabel-v1-refined.mjs");
const ME = "acct-me";
const adf = (text: string) => ({
  type: "doc", version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const comment = (text: string, author: string, created: string) => ({ body: adf(text), author: { accountId: author }, created });

interface Req { method: string; url: string; body: string }

describe("scripts/relabel-v1-refined.mjs", () => {
  let server: Server, base: string, reqs: Req[], tmp: string, noLoop: string, loop: string;
  let issues: { key: string; fields: { labels: string[] } }[];
  let comments: Record<string, object[]>;
  let pages = 1;

  beforeEach(async () => {
    reqs = [];
    pages = 1;
    issues = [
      { key: "T-1", fields: { labels: ["pipeline:research", "repo:r"] } },
      { key: "T-2", fields: { labels: ["pipeline:research", "repo:r"] } },
      { key: "T-3", fields: { labels: ["pipeline:research", "repo:r"] } },
      { key: "T-4", fields: { labels: ["pipeline:research", "repo:r"] } },
      { key: "T-5", fields: { labels: ["pipeline:research", "repo:r"] } },
    ];
    comments = {
      "T-1": [comment("✅ research-loop - refined", ME, "2026-01-02T00:00:00.000+0000")],
      // latest is a failure
      "T-2": [comment("✅ research-loop - refined", ME, "2026-01-01T00:00:00.000+0000"), comment("❌ research-loop - bounced", ME, "2026-01-03T00:00:00.000+0000")],
      // check by someone else
      "T-3": [comment("✅ research-loop - refined", "someone-else", "2026-01-02T00:00:00.000+0000")],
      // older failure, latest success, "## " prefix
      "T-4": [comment("❌ research-loop - bounced", ME, "2026-01-01T00:00:00.000+0000"), comment("## ✅ research-loop - refined", ME, "2026-01-04T00:00:00.000+0000")],
      // no research comment at all
      "T-5": [comment("random chatter", ME, "2026-01-05T00:00:00.000+0000")],
    };
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        reqs.push({ method: req.method!, url: req.url!, body });
        const u = new URL(req.url!, "http://x");
        res.setHeader("content-type", "application/json");
        if (u.pathname === "/rest/api/3/search/jql") {
          const token = (JSON.parse(body) as { nextPageToken?: string }).nextPageToken;
          if (pages === 2 && !token) return void res.end(JSON.stringify({ issues: issues.slice(0, 2), nextPageToken: "p2" }));
          if (pages === 2) return void res.end(JSON.stringify({ issues: issues.slice(2) }));
          return void res.end(JSON.stringify({ issues }));
        }
        const m = u.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/);
        if (m && req.method === "GET") {
          const all = comments[m[1]!] ?? [];
          const start = Number(u.searchParams.get("startAt") ?? 0);
          const max = Number(u.searchParams.get("maxResults") ?? 100);
          return void res.end(JSON.stringify({ comments: all.slice(start, start + Math.min(max, 1)), startAt: start, total: all.length }));
        }
        if (/^\/rest\/api\/3\/issue\/[A-Z]+-\d+$/.test(u.pathname) && req.method === "PUT") {
          res.statusCode = 204;
          return void res.end();
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    tmp = await mkdtemp(join(tmpdir(), "relabel-test-"));
    await writeFile(
      join(tmp, "pipeline.p.config.json"),
      JSON.stringify({ jira: { repoLabel: "repo:r" }, roles: { dev: { triggerLabel: "pipeline:v1dev" } } }),
    );
    noLoop = join(tmp, "pgrep-none");
    loop = join(tmp, "pgrep-loop");
    await writeFile(noLoop, "#!/bin/sh\nexit 1\n");
    await writeFile(loop, '#!/bin/sh\necho "1 node src/main.ts"\nexit 0\n');
    await chmod(noLoop, 0o755);
    await chmod(loop, 0o755);
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await rm(tmp, { recursive: true, force: true });
  });

  const go = (args: string[], pgrep = noLoop) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
      execFile(
        "node", [SCRIPT, "--project=p", `--root=${tmp}`, ...args],
        { env: { ...process.env, JIRA_BASE_URL: base, JIRA_EMAIL: "e@x", JIRA_API_TOKEN: "t", JIRA_ASSIGNEE_ACCOUNT_ID: ME, CUTOVER_PGREP: pgrep } },
        (err, stdout, stderr) => res({ code: err ? (err.code as number) : 0, stdout, stderr }),
      );
    });
  it("refuses the old --name value form, naming the replacement", async () => {
    const r = await go(["--confirm", "abc"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("use --confirm=abc");
  });
  const puts = () => reqs.filter((r) => r.method === "PUT");
  const hash = (keys: string[]) => createHash("sha256").update([...keys].sort().join("\n")).digest("hex");

  it("selects only tickets whose latest research comment is a check by the assignee", async () => {
    const r = await go([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("T-1");
    expect(r.stdout).toContain("T-4");
    for (const k of ["T-2", "T-3", "T-5"]) expect(r.stdout).not.toContain(k);
    expect(r.stdout).toContain("pipeline:research, repo:r");
    expect(r.stdout).toContain("pipeline:v1dev");
    expect(r.stdout).toContain(hash(["T-1", "T-4"]));
    expect(puts()).toHaveLength(0);
  });

  it("sends the documented JQL", async () => {
    await go([]);
    const search = JSON.parse(reqs.find((q) => q.url === "/rest/api/3/search/jql")!.body);
    expect(search.jql).toBe('labels = "pipeline:research" AND labels = "repo:r" AND status = "In Progress"');
  });

  it("paginates search results", async () => {
    pages = 2;
    const r = await go([]);
    expect(r.stdout).toContain(hash(["T-1", "T-4"]));
  });

  it("--write without --confirm refuses and writes nothing", async () => {
    const r = await go(["--write"]);
    expect(r.code).not.toBe(0);
    expect(puts()).toHaveLength(0);
  });

  it("--write with a wrong hash refuses and writes nothing", async () => {
    const r = await go(["--write", "--confirm=deadbeef"]);
    expect(r.code).not.toBe(0);
    expect(puts()).toHaveLength(0);
  });

  it("--write refuses while a loop is running, even with the right hash", async () => {
    const r = await go(["--write", `--confirm=${hash(["T-1", "T-4"])}`], loop);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("src/main.ts");
    expect(puts()).toHaveLength(0);
  });

  it("--write with the right hash only adds the dev label to selected tickets", async () => {
    const r = await go(["--write", `--confirm=${hash(["T-1", "T-4"])}`]);
    expect(r.code).toBe(0);
    expect(puts().map((p) => p.url).sort()).toEqual(["/rest/api/3/issue/T-1", "/rest/api/3/issue/T-4"]);
    for (const p of puts()) expect(JSON.parse(p.body)).toEqual({ update: { labels: [{ add: "pipeline:v1dev" }] } });
  });

  it("with zero selected tickets prints that and exits 0, even with --write", async () => {
    issues = [];
    const r = await go(["--write", "--confirm=x"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No tickets selected");
    expect(puts()).toHaveLength(0);
  });
});
