/**
 * GitHub access boundary for dev-loop's first GitHub write capability.
 * Mirrors JiraClient's interface style (src/jira-client.ts) and
 * research-loop's own GitHubClient (src/github-client.ts in that repo) --
 * narrow, purpose-built methods, never a generic "call gh" passthrough.
 * Shells out to the `gh` CLI (this pipeline family's established GitHub-
 * auth pattern -- see this repo's own PR-creation code in main.ts) rather
 * than a direct REST client, so this repo needs no second GitHub auth
 * scheme.
 *
 * Unlike research-loop's GitHubClient, this repo never creates the mirror
 * Issue -- research-loop already did, before handing a ticket off via the
 * pipeline:dev label swap -- so there is no createIssue here. addComment
 * and closeIssue are the two methods dev-loop actually needs: routing
 * bounce/landed detail to the mirror Issue (mirroring research-loop's own
 * Jira-brief/GitHub-full routing rule), and closing the Issue once a PR
 * merges. findIssueByJiraKey is ported unchanged from research-loop's own
 * implementation, since dev-loop has no other way to go from a Jira key
 * to an issue number -- no config field or Jira field ever records the
 * Issue number research-loop's createIssue returned.
 */

/** Minimal shape of a GitHub Issue as this pipeline needs it. */
export interface GitHubIssue {
  number: number;
  url: string;
  /** As reported by `gh issue list --json state`. */
  state: "OPEN" | "CLOSED";
}

/** GitHub's own three close reasons -- state_reason on the API, --reason on gh. */
export type IssueCloseReason = "completed" | "not_planned" | "duplicate";

export interface GitHubClient {
  /**
   * Find an existing mirror Issue for the given Jira ticket key, by
   * searching for an issue whose title starts with "<jiraKey>: " (the
   * title convention research-loop's own createIssue already
   * establishes). Returns null if none exists.
   */
  findIssueByJiraKey(jiraKey: string): Promise<GitHubIssue | null>;

  /**
   * Post a comment to the given issue number. Callers are responsible
   * for finding the issue number first (via findIssueByJiraKey) -- this
   * method takes a number, not a Jira key, since it's usually called
   * multiple times per run against the same already-resolved issue.
   */
  addComment(issueNumber: number, body: string): Promise<void>;

  /**
   * Close the given issue with the given reason. A safe no-op if the
   * issue is already closed -- callers (the merge-reconciliation pass)
   * must be able to re-run this idempotently without erroring on a
   * ticket that was already closed by a prior cycle, or by GitHub's own
   * "Closes #N" auto-close convention firing before this pass ever runs.
   */
  closeIssue(issueNumber: number, reason: IssueCloseReason): Promise<void>;

  /**
   * Close the PR at the given URL (not a number -- callers recover this
   * from RunLogLine.pr, which is always a full URL, not a bare number;
   * `gh pr close` accepts a URL directly, so no parse step is needed).
   * Used by reset-project's --close-remote, not by the normal pipeline
   * (which never closes its own PRs -- a human merges or closes by hand).
   *
   * "already-closed" covers two genuinely different `gh` outcomes,
   * verified live: closing an already-closed PR exits 0 with "already
   * closed" in its output (same shape as closeIssue's idempotency case);
   * closing an already-*merged* PR instead exits 1 with "can't be closed
   * because it was already merged" -- a different exit code and message,
   * but the same correct outcome for a reset: the PR is already in a
   * terminal state, nothing more to do. Any other gh failure (e.g. a
   * genuinely missing/deleted PR, an auth error) rethrows -- callers
   * that need to distinguish those cases handle it themselves; this
   * method only special-cases the two idempotency shapes above.
   */
  closePr(prUrl: string): Promise<ClosePrResult>;
}

export type ClosePrResult = "closed" | "already-closed";

const UNCONFIGURED_MESSAGE = (method: string): string =>
  `GitHubClient.${method}: GitHub repo target is not configured. ` +
  `Config.github.repo (pipeline.<project>.config.json) is still unfilled -- ` +
  `this needs a real "owner/repo" value before any GitHub call can be made.`;

/**
 * Placeholder GitHubClient. Every method throws until Config.github.repo
 * is filled in and a real client is wired in.
 */
export class StubGitHubClient implements GitHubClient {
  async findIssueByJiraKey(_jiraKey: string): Promise<GitHubIssue | null> {
    throw new Error(UNCONFIGURED_MESSAGE("findIssueByJiraKey"));
  }

  async addComment(_issueNumber: number, _body: string): Promise<void> {
    throw new Error(UNCONFIGURED_MESSAGE("addComment"));
  }

  async closeIssue(_issueNumber: number, _reason: IssueCloseReason): Promise<void> {
    throw new Error(UNCONFIGURED_MESSAGE("closeIssue"));
  }

  async closePr(_prUrl: string): Promise<ClosePrResult> {
    throw new Error(UNCONFIGURED_MESSAGE("closePr"));
  }
}

/** Stand-in for spawning `gh <args>` and returning its stdout. Injected so tests never shell out for real. */
export type ExecGhFn = (args: string[]) => Promise<string>;

interface GhIssueListEntry {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED";
}

/** gh's own --reason flag values use a literal space for "not planned", unlike the API's state_reason "not_planned". */
function toGhCloseReason(reason: IssueCloseReason): string {
  return reason === "not_planned" ? "not planned" : reason;
}

/**
 * Recognizes gh's own "already closed" error text so closeIssue can be a
 * safe idempotent no-op instead of throwing on a re-run. Matched loosely
 * (substring, case-insensitive) since gh/GitHub's own wording for this
 * case isn't a documented stable contract -- over-matching here just
 * risks swallowing a genuinely different close failure as a no-op, which
 * is an acceptable tradeoff for an operation whose whole purpose is
 * "don't fail if already done."
 */
function isAlreadyClosedError(message: string): boolean {
  return /already closed/i.test(message);
}

/**
 * Recognizes gh's "already closed" (exit 0) AND "already merged" (exit 1)
 * error text, both verified live -- closePr's own idempotency check.
 * `isAlreadyClosedError` alone doesn't cover the merged case: a merged
 * PR's message never contains "already closed" at all.
 */
function isAlreadyClosedOrMergedError(message: string): boolean {
  return /already (closed|merged)/i.test(message);
}

/**
 * gh-CLI-backed GitHubClient. `execFn` is injected -- production wiring
 * passes realExecGh(), tests pass a vi.fn() stand-in.
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
      "number,url,state",
    ]);
    const entries = JSON.parse(stdout) as GhIssueListEntry[];
    const first = entries[0];
    if (!first) return null;
    return { number: first.number, url: first.url, state: first.state };
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    await this.execFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      this.repo,
      "--body",
      body,
    ]);
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

  async closePr(prUrl: string): Promise<ClosePrResult> {
    try {
      await this.execFn(["pr", "close", prUrl, "--repo", this.repo]);
      return "closed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAlreadyClosedOrMergedError(message)) return "already-closed";
      throw err;
    }
  }
}

/**
 * Real `execFn` for production wiring: spawns `gh <args>` via execFile,
 * returning stdout. Throws with gh's own stderr included on a non-zero
 * exit, so a caller sees the real reason rather than a bare exit-code
 * message.
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
