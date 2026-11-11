/**
 * GitHub access boundary for research-loop's Phase 1 GitHub-Issue mirror
 * (docs/future-enhancements.md's Jira label-trigger design). Mirrors
 * JiraClient's interface style (src/jira-client.ts) -- narrow, purpose-
 * built methods, never a generic "call gh" passthrough. Shells out to the
 * `gh` CLI (already this pipeline family's established GitHub-auth
 * pattern -- see dev-loop's PR-creation code) rather than a direct REST
 * client, so this repo needs no second GitHub auth scheme.
 */

/** Minimal shape of a GitHub Issue as this pipeline needs it. */
export interface GitHubIssue {
  number: number;
  url: string;
}

export interface GitHubClient {
  /**
   * Find an existing mirror Issue for the given Jira ticket key, by
   * searching for an issue whose title starts with "<jiraKey>: " (this
   * repo's own title convention -- see createIssue). Returns null if none
   * exists. Callers use this for idempotency: check before creating, to
   * avoid a duplicate Issue from a poll-loop race (the same class of race
   * the postRunDelaySec fix addressed for Jira polling).
   */
  findIssueByJiraKey(jiraKey: string): Promise<GitHubIssue | null>;

  /**
   * Create a new mirror Issue. Callers are responsible for calling
   * findIssueByJiraKey first and skipping this call if one already
   * exists -- this method itself does not check.
   */
  createIssue(params: { title: string; body: string; jiraKey: string }): Promise<GitHubIssue>;

  /**
   * Close the given issue with the given reason. A safe no-op if the
   * issue is already closed. Used by reset-project's --close-remote, not
   * by the normal pipeline -- research-loop never closes its own mirror
   * Issues (that's dev-loop's merge-reconciliation pass's job); ported
   * from dev-loop's identical method.
   */
  closeIssue(issueNumber: number, reason: IssueCloseReason): Promise<void>;
}

/** GitHub's own three close reasons -- state_reason on the API, --reason on gh. */
export type IssueCloseReason = "completed" | "not_planned" | "duplicate";

const UNCONFIGURED_MESSAGE = (method: string): string =>
  `GitHubClient.${method}: GitHub repo target is not configured. ` +
  `Config.github.repo (pipeline.<project>.config.json) is still unfilled -- ` +
  `this needs a real "owner/repo" value before any GitHub call can be made.`;

/**
 * Placeholder GitHubClient. Every method throws until Config.github.repo
 * is filled in and a real client is wired in. Exists so callers have
 * something concrete to run against outside of tests without silently
 * pretending to talk to GitHub.
 */
export class StubGitHubClient implements GitHubClient {
  async findIssueByJiraKey(_jiraKey: string): Promise<GitHubIssue | null> {
    throw new Error(UNCONFIGURED_MESSAGE("findIssueByJiraKey"));
  }

  async createIssue(_params: {
    title: string;
    body: string;
    jiraKey: string;
  }): Promise<GitHubIssue> {
    throw new Error(UNCONFIGURED_MESSAGE("createIssue"));
  }

  async closeIssue(_issueNumber: number, _reason: IssueCloseReason): Promise<void> {
    throw new Error(UNCONFIGURED_MESSAGE("closeIssue"));
  }
}

/** Stand-in for spawning `gh <args>` and returning its stdout. Injected so tests never shell out for real. */
export type ExecGhFn = (args: string[]) => Promise<string>;

interface GhIssueListEntry {
  number: number;
  url: string;
}

/** gh's own --reason flag values use a literal space for "not planned", unlike the API's state_reason "not_planned". */
function toGhCloseReason(reason: IssueCloseReason): string {
  return reason === "not_planned" ? "not planned" : reason;
}

/**
 * Recognizes gh's own "already closed" error text so closeIssue can be a
 * safe idempotent no-op instead of throwing on a re-run. Matched loosely
 * (substring, case-insensitive) since gh/GitHub's own wording for this
 * case isn't a documented stable contract -- ported from dev-loop's
 * identical function, whose own doc comment has the full rationale.
 */
function isAlreadyClosedError(message: string): boolean {
  return /already closed/i.test(message);
}

/**
 * gh-CLI-backed GitHubClient. `execFn` defaults to a real `gh` spawn via
 * node:child_process's execFile, promisified -- injectable for tests.
 */
export class RealGitHubClient implements GitHubClient {
  private readonly repo: string;
  private readonly execFn: ExecGhFn;

  constructor(config: { repo: string }, execFn: ExecGhFn) {
    this.repo = config.repo;
    this.execFn = execFn;
  }

  async findIssueByJiraKey(jiraKey: string): Promise<GitHubIssue | null> {
    const stdout = await this.execFn([
      "issue",
      "list",
      "--repo",
      this.repo,
      "--search",
      `in:title "${jiraKey}:"`,
      "--state",
      "all",
      "--json",
      "number,url",
    ]);
    const entries = JSON.parse(stdout) as GhIssueListEntry[];
    const first = entries[0];
    if (!first) return null;
    return { number: first.number, url: first.url };
  }

  async createIssue(params: {
    title: string;
    body: string;
    jiraKey: string;
  }): Promise<GitHubIssue> {
    const stdout = await this.execFn([
      "issue",
      "create",
      "--repo",
      this.repo,
      "--title",
      params.title,
      "--body",
      params.body,
    ]);
    const url = stdout.trim();
    const match = url.match(/\/issues\/(\d+)$/);
    if (!match) {
      throw new Error(
        `RealGitHubClient.createIssue: could not parse an issue number from gh's own output: "${url}"`,
      );
    }
    return { number: Number(match[1]), url };
  }

  async closeIssue(issueNumber: number, reason: IssueCloseReason): Promise<void> {
    try {
      await this.execFn([
        "issue",
        "close",
        String(issueNumber),
        "--repo",
        this.repo,
        "--reason",
        toGhCloseReason(reason),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAlreadyClosedError(message)) return;
      throw err;
    }
  }
}

/**
 * Real `execFn` for production wiring: spawns `gh <args>` via execFile,
 * returning stdout. Throws with gh's own stderr included on a non-zero
 * exit, so a caller sees the real reason (e.g. "gh: authentication
 * required") rather than a bare exit-code message.
 */
export function realExecGh(): ExecGhFn {
  return async (args: string[]): Promise<string> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync("gh", args);
      return stdout;
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(stderr ? `${message}: ${stderr}` : message);
    }
  };
}
