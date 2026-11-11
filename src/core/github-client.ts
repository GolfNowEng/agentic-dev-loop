/**
 * GitHub access boundary for the pipeline's GitHub-Issue mirror, shared by
 * both roles. Mirrors JiraClient's interface style (src/core/jira-client.ts)
 * -- narrow, purpose-built methods, never a generic "call gh" passthrough.
 * Shells out to the `gh` CLI (this pipeline family's established GitHub-
 * auth pattern) rather than a direct REST client, so no second GitHub auth
 * scheme is needed.
 *
 * The union of both v1 clients: the research role creates the mirror Issue
 * (createIssue, guarded by findIssueByJiraKey for idempotency); the dev
 * role comments on it (addComment), closes it once a PR merges
 * (closeIssue), and reset-project's --close-remote closes an open PR
 * (closePr). Every method exists on both StubGitHubClient and
 * RealGitHubClient; which ones a role calls is the role's business.
 */

import { TICKET_KEY } from "./paths.ts";

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
   * title convention createIssue's callers follow). Returns null if none
   * exists. Callers use this for idempotency: check before creating, to
   * avoid a duplicate Issue from a poll-loop race.
   */
  findIssueByJiraKey(jiraKey: string): Promise<GitHubIssue | null>;

  /**
   * Create a new mirror Issue. Callers are responsible for calling
   * findIssueByJiraKey first and skipping this call if one already
   * exists -- this method itself does not check. A just-created Issue is
   * always OPEN, so the returned state is "OPEN".
   */
  createIssue(params: { title: string; body: string; jiraKey: string }): Promise<GitHubIssue>;

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

  async createIssue(_params: {
    title: string;
    body: string;
    jiraKey: string;
  }): Promise<GitHubIssue> {
    throw new Error(UNCONFIGURED_MESSAGE("createIssue"));
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
    return { number: Number(match[1]), url, state: "OPEN" };
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

/** Stand-in for `gh pr view <url> --json state,mergedAt,baseRefName`, returning its raw JSON stdout. Injected so tests never shell out for real. */
export type ExecGhPrViewFn = (prUrl: string) => Promise<string>;

/** A merged PR found by ticket key. `baseRefName` is the branch it merged into. */
export interface MergedPr {
  url: string;
  mergedAt: string;
  baseRefName: string;
}

/**
 * Find a merged PR in the target repo that carries this ticket's work
 * (matched by ticket key as a whole token in head branch or title), or null.
 * With `opts.baseRefName`, only PRs merged into that branch count.
 */
export type ExecGhFindMergedPrFn = (
  ticketKey: string,
  opts?: { baseRefName?: string },
) => Promise<MergedPr | null>;

/** Escape `text` for literal use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `text` contains `ticketKey` as a whole token, so TARS-148 never
 * matches TARS-1487 and TARS-1 never matches TARS-12.
 */
export function containsTicketToken(text: string, ticketKey: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(ticketKey)}($|[^0-9])`).test(text);
}

/**
 * Real ExecGhPrViewFn for production wiring: runs
 * `gh pr view <url> --json state,mergedAt,baseRefName`, returning stdout.
 * Callers that only read state/mergedAt (reconcile, the landed-ticket guard)
 * ignore baseRefName; the blocker gate requires it to equal the default branch.
 */
export function realExecGhPrView(exec: ExecGhFn = realExecGh()): ExecGhPrViewFn {
  return (prUrl: string) => exec(["pr", "view", prUrl, "--json", "state,mergedAt,baseRefName"]);
}

/**
 * Real ExecGhFindMergedPrFn: lists merged PRs in `repo` mentioning the ticket
 * key, keeping only those whose head branch or title contains it as a whole
 * token (containsTicketToken), optionally only those merged into
 * `opts.baseRefName`. Latest merge wins.
 */
export function realExecGhFindMergedPr(repo: string, exec: ExecGhFn = realExecGh()): ExecGhFindMergedPrFn {
  return async (ticketKey, opts) => {
    const stdout = await exec([
      "pr", "list", "-R", repo, "--state", "merged", "--search", ticketKey,
      "--json", "url,mergedAt,title,headRefName,baseRefName", "--limit", "20",
    ]);
    const base = opts?.baseRefName;
    const prs = (JSON.parse(stdout) as Array<MergedPr & { title: string; headRefName: string }>)
      .filter((p) => p.mergedAt && (containsTicketToken(p.headRefName, ticketKey) || containsTicketToken(p.title, ticketKey)))
      .filter((p) => base === undefined || p.baseRefName === base)
      .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    const top = prs[0];
    return top ? { url: top.url, mergedAt: top.mergedAt, baseRefName: top.baseRefName } : null;
  };
}

/**
 * Real `findOpenPrUrl` for the worker's crash recovery: the newest open PR in
 * `repo` whose head branch or title carries the ticket key as a whole token
 * (`gh pr list --state open --search <key>`, filtered with
 * containsTicketToken, the same match reconcile and the blocker gate use), or
 * null. The key is validated before gh runs.
 */
export function realFindOpenPrUrl(repo: string, exec: ExecGhFn = realExecGh()): (ticketKey: string) => Promise<string | null> {
  return async (ticketKey) => {
    if (typeof ticketKey !== "string" || !TICKET_KEY.test(ticketKey)) {
      throw new Error(`realFindOpenPrUrl: invalid ticket key ${JSON.stringify(ticketKey)}`);
    }
    const stdout = await exec([
      "pr", "list", "-R", repo, "--state", "open", "--search", ticketKey,
      "--json", "url,title,headRefName", "--limit", "20",
    ]);
    const prs = JSON.parse(stdout) as Array<{ url: string; title: string; headRefName: string }>;
    const hit = prs.find((p) => containsTicketToken(p.headRefName, ticketKey) || containsTicketToken(p.title, ticketKey));
    return hit?.url ?? null;
  };
}

/** `owner/name`, each part limited to GitHub's own name characters. */
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The repo's default branch, from
 * `gh repo view <repo> --json defaultBranchRef --jq .defaultBranchRef.name`.
 * `repo` is validated as owner/name before gh runs (execFile, no shell).
 */
export async function realDefaultBranch(repo: string, exec: ExecGhFn = realExecGh()): Promise<string> {
  if (!REPO_SLUG.test(repo) || repo.startsWith("-")) {
    throw new Error(`realDefaultBranch: invalid repo ${JSON.stringify(repo)} (expected owner/name)`);
  }
  const name = (await exec(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])).trim();
  if (!name) throw new Error(`realDefaultBranch: gh returned no default branch for ${repo}`);
  return name;
}
