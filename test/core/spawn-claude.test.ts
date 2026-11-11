import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnClaudeRun,
  childEnv,
  killedTimeoutVerdict,
} from "../../src/core/spawn-claude.ts";
import type { SpawnClaudeOpts, SpawnFn, SpawnClaudeDeps } from "../../src/core/spawn-claude.ts";
import { parseVerdict } from "../../src/core/verdict.ts";
import { ALLOWED_TOOLS as DEV_ALLOWED_TOOLS } from "../../src/roles/dev/tools.ts";
import { ALLOWED_TOOLS as RESEARCH_ALLOWED_TOOLS } from "../../src/roles/research/tools.ts";

/** A fake ChildProcess: stdout/stderr streams, emits error/close, records kill signals. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  /** When set, the child "dies" on this signal (emits close). Otherwise it ignores kills. */
  constructor(private readonly diesOn: string | null = null) {
    super();
  }
  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === this.diesOn || signal === "SIGKILL") {
      setImmediate(() => this.emit("close", null, signal));
    }
    return true;
  }
  /** Write stdout, then exit with `code`. */
  finish(stdout: string, code = 0): void {
    this.stdout.end(stdout);
    this.stderr.end();
    setImmediate(() => this.emit("close", code, null));
  }
}

/** Manual clock: injected setTimeout/clearTimeout that fire only on advance(). */
function makeFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: ((fn: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    }) as unknown as SpawnClaudeDeps["setTimeout"],
    clearTimeout: ((id: number) => {
      pending.delete(id);
    }) as unknown as SpawnClaudeDeps["clearTimeout"],
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("spawnClaudeRun", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-claude-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeOpts(overrides: Partial<SpawnClaudeOpts> = {}): SpawnClaudeOpts {
    return {
      prompt: "/ticket-to-pr TARS-1",
      model: "sonnet",
      allowedTools: "Bash,Read",
      addDir: null,
      timeoutMin: 75,
      maxBudgetUsd: 20,
      stream: false,
      ticketKey: "TARS-1",
      rawUsagePath: join(dir, "raw-usage", "TARS-1-x.json"),
      env: { PATH: "/usr/bin" },
      ...overrides,
    };
  }

  function quietDeps(extra: Partial<SpawnClaudeDeps> = {}): SpawnClaudeDeps {
    return { log: () => {}, logError: () => {}, ...extra };
  }

  it("reports a spawn error (child 'error' event) through spawnError and never throws", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      setImmediate(() => child.emit("error", new Error("spawn claude ENOENT")));
      return child as never;
    };

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn }));

    expect(result.spawnError).toMatch(/ENOENT/);
    expect(result.killedTimeout).toBe(false);
    expect(result.usage).toEqual({ costUsd: 0, tokens: { in: 0, out: 0 } });
  });

  it("reports a synchronous spawn() throw through spawnError and never throws", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("EAGAIN");
    };

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn }));

    expect(result.spawnError).toMatch(/EAGAIN/);
    expect(result.killedTimeout).toBe(false);
  });

  it("reports a nonzero exit through spawnError", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish("boom", 1);
      return child as never;
    };

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn }));

    expect(result.spawnError).toMatch(/exited with code 1/);
  });

  it("writes raw stdout, redacted, to rawUsagePath before parsing it, and extracts usage", async () => {
    const stdout = JSON.stringify({
      total_cost_usd: 1.5,
      usage: { input_tokens: 10, output_tokens: 3 },
      result: "found API_TOKEN=abcdefghijklmnop1234 in .env",
    });
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish(stdout);
      return child as never;
    };
    const opts = makeOpts();

    const result = await spawnClaudeRun(opts, quietDeps({ spawn }));

    const written = await readFile(opts.rawUsagePath, "utf8");
    expect(written).not.toContain("abcdefghijklmnop1234");
    expect(written).toContain("total_cost_usd");
    expect(result.usage.costUsd).toBe(1.5);
    expect(result.usage.tokens.out).toBe(3);
    expect(result.spawnError).toBeUndefined();
  });

  it("still writes raw stdout when it is not valid JSON (parse failure loses nothing)", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish("not json at all");
      return child as never;
    };
    const opts = makeOpts();

    const result = await spawnClaudeRun(opts, quietDeps({ spawn }));

    expect(await readFile(opts.rawUsagePath, "utf8")).toBe("not json at all");
    expect(result.usage.costUsd).toBe(0);
  });

  it("always passes --max-budget-usd <maxBudgetUsd>", async () => {
    let seenArgs: string[] = [];
    const child = new FakeChild();
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      child.finish("{}");
      return child as never;
    };

    await spawnClaudeRun(makeOpts({ maxBudgetUsd: 50 }), quietDeps({ spawn }));

    const i = seenArgs.indexOf("--max-budget-usd");
    expect(i).toBeGreaterThan(-1);
    expect(seenArgs[i + 1]).toBe("50");
  });

  it("passes prompt, model, allowedTools and addDir, and json output when not streaming", async () => {
    let seen: { cmd: string; args: string[] } = { cmd: "", args: [] };
    const child = new FakeChild();
    const spawn: SpawnFn = (cmd, args) => {
      seen = { cmd, args };
      child.finish("{}");
      return child as never;
    };

    await spawnClaudeRun(makeOpts({ addDir: "/abs/target" }), quietDeps({ spawn }));

    expect(seen.cmd).toBe("claude");
    expect(seen.args.slice(0, 2)).toEqual(["-p", "/ticket-to-pr TARS-1"]);
    expect(seen.args).toEqual(expect.arrayContaining(["--model", "sonnet", "--allowedTools", "Bash,Read"]));
    expect(seen.args[seen.args.indexOf("--add-dir") + 1]).toBe("/abs/target");
    expect(seen.args[seen.args.indexOf("--output-format") + 1]).toBe("json");
  });

  it("streaming: returns the result line as stdout", async () => {
    let seenArgs: string[] = [];
    const child = new FakeChild();
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      const lines = [
        JSON.stringify({ type: "system" }),
        JSON.stringify({ type: "result", total_cost_usd: 2 }),
        "",
      ].join("\n");
      child.finish(lines);
      return child as never;
    };

    const result = await spawnClaudeRun(makeOpts({ stream: true }), quietDeps({ spawn }));

    expect(seenArgs[seenArgs.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(seenArgs).toContain("--verbose");
    expect(JSON.parse(result.stdout).type).toBe("result");
    expect(result.usage.costUsd).toBe(2);
  });

  it("kills a child that never exits: SIGTERM at timeoutMin, SIGKILL 30 s later, killedTimeout: true", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild(null); // ignores SIGTERM
    const spawn: SpawnFn = () => child as never;

    const pending = spawnClaudeRun(makeOpts({ timeoutMin: 2 }), quietDeps({ spawn, ...timers }));
    await flush();

    timers.advance(2 * 60_000 - 1);
    expect(child.signals).toEqual([]);
    timers.advance(1);
    expect(child.signals).toEqual(["SIGTERM"]);
    timers.advance(30_000 - 1);
    expect(child.signals).toEqual(["SIGTERM"]);
    timers.advance(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

    const result = await pending;
    expect(result.killedTimeout).toBe(true);
    expect(result.spawnError).toBeUndefined();
    expect(timers.pendingCount()).toBe(0);
  });

  it("does not send SIGKILL when the child exits on SIGTERM", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild("SIGTERM");
    const spawn: SpawnFn = () => child as never;

    const pending = spawnClaudeRun(makeOpts({ timeoutMin: 1 }), quietDeps({ spawn, ...timers }));
    await flush();
    timers.advance(60_000);
    const result = await pending;
    timers.advance(30_000);

    expect(child.signals).toEqual(["SIGTERM"]);
    expect(result.killedTimeout).toBe(true);
  });

  it("clears its timers when the child exits normally", async () => {
    const timers = makeFakeTimers();
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish("{}");
      return child as never;
    };

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn, ...timers }));

    expect(result.killedTimeout).toBe(false);
    expect(timers.pendingCount()).toBe(0);
  });

  it("spawns the child with childEnv(env): no JIRA_API_TOKEN/JIRA_EMAIL/JIRA_BASE_URL", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const child = new FakeChild();
    const spawn: SpawnFn = (_cmd, _args, options) => {
      seenEnv = options.env;
      child.finish("{}");
      return child as never;
    };
    const env = {
      PATH: "/usr/bin",
      JIRA_API_TOKEN: "t",
      JIRA_EMAIL: "e",
      JIRA_BASE_URL: "u",
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "4500000",
    };

    await spawnClaudeRun(makeOpts({ env }), quietDeps({ spawn }));

    expect(seenEnv).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "4500000" });
  });

  it("records started/ended as ISO timestamps from the injected clock", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = () => {
      child.finish("{}");
      return child as never;
    };
    const times = [new Date("2026-11-10T10:00:00Z"), new Date("2026-11-10T10:05:00Z")];
    const now = () => times.shift() ?? new Date("2026-11-10T11:00:00Z");

    const result = await spawnClaudeRun(makeOpts(), quietDeps({ spawn, now }));

    expect(result.started).toBe("2026-11-10T10:00:00.000Z");
    expect(result.ended).toBe("2026-11-10T10:05:00.000Z");
  });
});

describe("childEnv", () => {
  it("strips JIRA_API_TOKEN, JIRA_EMAIL and JIRA_BASE_URL, keeps everything else, and does not mutate the parent", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      JIRA_API_TOKEN: "secret",
      JIRA_EMAIL: "me@example.com",
      JIRA_BASE_URL: "https://x.atlassian.net",
      JIRA_ASSIGNEE_ACCOUNT_ID: "acct-1",
    };

    const env = childEnv(parent);

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", JIRA_ASSIGNEE_ACCOUNT_ID: "acct-1" });
    expect(parent.JIRA_API_TOKEN).toBe("secret");
  });
});

describe("killedTimeoutVerdict", () => {
  it("is outcome killed / failure_category killed_ceiling, and valid under both verdict profiles", () => {
    const verdict = killedTimeoutVerdict(75);
    expect(verdict.outcome).toBe("killed");
    expect(verdict.failure_category).toBe("killed_ceiling");
    expect(verdict.detail).toMatch(/75/);

    const raw = JSON.stringify(verdict);
    expect(parseVerdict(raw, "refine").outcome).toBe("killed");
    expect(parseVerdict(raw, "executor").outcome).toBe("killed");
  });
});

// Byte-for-byte the strings each v1 main.ts passed to --allowedTools at
// ad1ad2a (src/main.ts:59 and research-loop/src/main.ts:66). Never unioned.
describe("role ALLOWED_TOOLS", () => {
  it("dev equals its v1 constant", () => {
    expect(DEV_ALLOWED_TOOLS).toBe(
      "mcp__atlassian__getAccessibleAtlassianResources,mcp__atlassian__getJiraIssue,Bash,Read,Grep,Glob",
    );
  });

  it("research equals its v1 constant", () => {
    expect(RESEARCH_ALLOWED_TOOLS).toBe(
      "mcp__atlassian__getAccessibleAtlassianResources,mcp__atlassian__getJiraIssue,mcp__atlassian__searchJiraIssuesUsingJql,mcp__atlassian__addCommentToJiraIssue,mcp__atlassian__editJiraIssue,mcp__atlassian__search,mcp__atlassian__getConfluencePage,mcp__atlassian__searchConfluenceUsingCql,Bash,Read,Grep,Glob",
    );
  });
});
