// Jira client boundary. The loop runner depends only on this interface, so
// tests can inject a mock instead of touching real Jira.
//
// Appendix A of the pipeline spec (the concrete Jira instance/binding
// values: base URL, auth, status IDs, epic link field, etc.) is currently
// unfilled - pipeline.config.json has every value set to the literal
// string "___". Until that's filled in there is no real Jira to bind to,
// so StubJiraClient throws on every call.

import type { Config } from "./types.ts";

export interface JiraTicket {
  key: string;
  status: string;
  /** Jira accountId of the current assignee, or null if unassigned. */
  assignee: string | null;
}

export interface JiraClient {
  /**
   * Poll Jira for the oldest ticket matching the given JQL. Returns null
   * if no ticket matches.
   */
  pollOldestMatching(jql: string): Promise<JiraTicket | null>;

  /**
   * Poll Jira for every ticket matching the given JQL (not just the
   * oldest) -- used by the merge-reconciliation pass, which needs to
   * check every ticket currently at Code Review, not claim one at a time
   * the way the main poll loop does.
   */
  pollAllMatching(jql: string): Promise<JiraTicket[]>;

  /**
   * Attempt to atomically claim a ticket by transitioning it from one
   * status to another. Returns false (never throws) if the transition
   * failed because another process raced it and already moved the
   * ticket - the caller should skip this ticket and continue, not treat
   * that as an error.
   */
  claimTicket(ticketKey: string, from: string, to: string): Promise<boolean>;

  /**
   * Transition a ticket to a new status (not a claim - used for
   * post-run outcome transitions such as marking a ticket "bounced" or
   * moving it toward "landed"). `fields`, if given, is sent alongside the
   * transition request -- some transitions have a required Jira screen
   * (e.g. Code Review's PII/QA-notes fields) that rejects an empty
   * payload even when the field schema itself reports `required: false`.
   */
  transitionStatus(
    ticketKey: string,
    to: string,
    fields?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Swap a ticket's pipeline-stage label from `from` to `to` in one PUT
   * (Jira's labels field supports a remove/add op pair directly -- no
   * GET-then-merge needed).
   */
  swapLabel(ticketKey: string, from: string, to: string): Promise<void>;

  /**
   * Assign a ticket to the given Jira account ID. Callers should only
   * invoke this when the ticket is currently unassigned -- this method
   * itself does not check, it just performs the assignment.
   */
  assignTicket(ticketKey: string, accountId: string): Promise<void>;

  /**
   * Post a comment to a ticket. `bodyAdf` must be a full Atlassian Document
   * Format doc (`{ type: "doc", version: 1, content: [...] }`), not a plain
   * string -- Jira's v3 comment endpoint rejects a bare string body the
   * same way its transition-screen rich-text fields do (see
   * buildQaNotesAdf's doc comment in loop-runner.ts).
   */
  addComment(ticketKey: string, bodyAdf: Record<string, unknown>): Promise<void>;

  /**
   * Close a ticket for good -- used by reset-project's --close-remote, not
   * by the normal pipeline (which never closes a ticket itself; a human
   * does that by hand). This Jira instance has no single "close" status
   * name that's guaranteed to exist across every project's workflow
   * (unlike statusNames.bounced/prOpen, which are per-project config), so
   * this discovers a target by status *category* instead: any status
   * whose statusCategory.key is "done" counts as closed, regardless of
   * its literal name ("Closed", "Done", "Won't Do", ...).
   *
   * "already-done": the ticket's current status is already in the done
   * category -- a safe idempotent no-op, no transition attempted.
   * "no-transition": the ticket isn't done, and no transition to a
   * done-category status is offered from its current status (e.g. a
   * workflow that requires an intermediate status first) -- never
   * silently treated as success.
   * "closed": a transition was found and successfully applied.
   *
   * If more than one done-category transition is offered, the first one
   * (by the API's own ordering) is used -- there is no per-project config
   * to prefer one by name. `transitionName` on a "closed" result always
   * names which one was actually used, so a wrong pick anywhere is
   * visible rather than silent.
   */
  closeTicket(ticketKey: string): Promise<CloseTicketResult>;
}

export type CloseTicketResult =
  | { result: "already-done" }
  | { result: "closed"; transitionName: string }
  | { result: "no-transition" };

/**
 * Stand-in JiraClient used until Appendix A of the pipeline spec is
 * filled in with real Jira binding values (base URL, auth, status IDs,
 * epic link field, etc.). Every method throws a clear, actionable error
 * rather than silently doing nothing or hitting a real API.
 */
export class StubJiraClient implements JiraClient {
  private static notConfigured(method: string): Error {
    return new Error(
      `StubJiraClient.${method}: Jira instance is not configured. ` +
        `Appendix A of the pipeline spec is unfilled (pipeline.config.json ` +
        `still has placeholder "___" values) - this needs real Jira ` +
        `binding values (base URL, auth, status IDs, epic link field, etc.) ` +
        `before ${method} can do anything real.`,
    );
  }

  async pollOldestMatching(_jql: string): Promise<JiraTicket | null> {
    throw StubJiraClient.notConfigured("pollOldestMatching");
  }

  async pollAllMatching(_jql: string): Promise<JiraTicket[]> {
    throw StubJiraClient.notConfigured("pollAllMatching");
  }

  async claimTicket(
    _ticketKey: string,
    _from: string,
    _to: string,
  ): Promise<boolean> {
    throw StubJiraClient.notConfigured("claimTicket");
  }

  async transitionStatus(
    _ticketKey: string,
    _to: string,
    _fields?: Record<string, unknown>,
  ): Promise<void> {
    throw StubJiraClient.notConfigured("transitionStatus");
  }

  async swapLabel(_ticketKey: string, _from: string, _to: string): Promise<void> {
    throw StubJiraClient.notConfigured("swapLabel");
  }

  async assignTicket(_ticketKey: string, _accountId: string): Promise<void> {
    throw StubJiraClient.notConfigured("assignTicket");
  }

  async addComment(
    _ticketKey: string,
    _bodyAdf: Record<string, unknown>,
  ): Promise<void> {
    throw StubJiraClient.notConfigured("addComment");
  }

  async closeTicket(_ticketKey: string): Promise<CloseTicketResult> {
    throw StubJiraClient.notConfigured("closeTicket");
  }
}

/** Credentials RealJiraClient needs, read from process.env by callers. */
export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

/** Reads JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN from process.env, or throws. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): JiraCredentials {
  const baseUrl = env.JIRA_BASE_URL;
  const email = env.JIRA_EMAIL;
  const apiToken = env.JIRA_API_TOKEN;
  const missing = [
    !baseUrl && "JIRA_BASE_URL",
    !email && "JIRA_EMAIL",
    !apiToken && "JIRA_API_TOKEN",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `RealJiraClient: missing required env var(s): ${missing.join(", ")}. ` +
        `Set them in a gitignored .env (see .env.example) and run with ` +
        `"node --env-file=.env ...".`,
    );
  }
  return { baseUrl: baseUrl!, email: email!, apiToken: apiToken! };
}

/**
 * Reads JIRA_ASSIGNEE_ACCOUNT_ID from process.env, or throws. Kept separate
 * from JiraCredentials/credentialsFromEnv since this isn't an API
 * credential -- it's the human's own Jira account ID, used as a call-time
 * argument (assignTicket) and in JQL, not something RealJiraClient holds
 * as constructor state.
 */
export function assigneeAccountIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const accountId = env.JIRA_ASSIGNEE_ACCOUNT_ID;
  if (!accountId) {
    throw new Error(
      "RealJiraClient: missing required env var JIRA_ASSIGNEE_ACCOUNT_ID. " +
        "Set it in a gitignored .env (see .env.example) and run with " +
        '"node --env-file=.env ...".',
    );
  }
  return accountId;
}

interface JiraSearchResponse {
  issues: Array<{
    key: string;
    fields: {
      status: { name: string };
      assignee: { accountId: string } | null;
    };
  }>;
}

interface JiraTransitionsResponse {
  transitions: Array<{ id: string; to: { name: string; statusCategory: { key: string } } }>;
}

interface JiraStatusFieldResponse {
  fields: { status: { name: string; statusCategory: { key: string } } };
}

/**
 * REST-backed JiraClient for Jira Cloud, authenticated via HTTP Basic auth
 * (email + API token) per Atlassian's documented auth scheme for the v3
 * REST API.
 */
export class RealJiraClient implements JiraClient {
  private readonly credentials: JiraCredentials;
  private readonly config: Config;

  // Explicit fields, not TS parameter-property shorthand -- Node's
  // type-stripping mode (used to run src/*.ts directly without a build
  // step) does not support parameter properties.
  constructor(credentials: JiraCredentials, config: Config) {
    this.credentials = credentials;
    this.config = config;
  }

  private authHeader(): string {
    const { email, apiToken } = this.credentials;
    return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.credentials.baseUrl}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Jira request failed: ${init.method ?? "GET"} ${path} -> ${response.status} ${response.statusText}. ${body}`,
      );
    }
    return response;
  }

  async pollOldestMatching(jql: string): Promise<JiraTicket | null> {
    const response = await this.request("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults: 1,
        fields: ["status", "assignee"],
      }),
    });
    const data = (await response.json()) as JiraSearchResponse;
    const issue = data.issues[0];
    if (!issue) return null;

    return {
      key: issue.key,
      status: issue.fields.status.name,
      assignee: issue.fields.assignee?.accountId ?? null,
    };
  }

  async pollAllMatching(jql: string): Promise<JiraTicket[]> {
    const response = await this.request("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        fields: ["status", "assignee"],
      }),
    });
    const data = (await response.json()) as JiraSearchResponse;
    return data.issues.map((issue) => ({
      key: issue.key,
      status: issue.fields.status.name,
      assignee: issue.fields.assignee?.accountId ?? null,
    }));
  }

  async claimTicket(ticketKey: string, from: string, to: string): Promise<boolean> {
    const response = await this.request(`/rest/api/3/issue/${ticketKey}/transitions`);
    const data = (await response.json()) as JiraTransitionsResponse;
    const transition = data.transitions.find((t) => t.to.name === to);
    if (!transition) {
      // Ticket is no longer at `from` (or `to` isn't reachable) -- another
      // process already claimed it. Skip, do not throw.
      return false;
    }
    await this.request(`/rest/api/3/issue/${ticketKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
    return true;
  }

  async transitionStatus(
    ticketKey: string,
    to: string,
    fields?: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.request(`/rest/api/3/issue/${ticketKey}/transitions`);
    const data = (await response.json()) as JiraTransitionsResponse;
    const transition = data.transitions.find((t) => t.to.name === to);
    if (!transition) {
      throw new Error(
        `RealJiraClient.transitionStatus: no transition to status "${to}" is ` +
          `available for ${ticketKey} from its current status.`,
      );
    }
    await this.request(`/rest/api/3/issue/${ticketKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({
        transition: { id: transition.id },
        ...(fields ? { fields } : {}),
      }),
    });
  }

  async swapLabel(ticketKey: string, from: string, to: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({
        update: { labels: [{ remove: from }, { add: to }] },
      }),
    });
  }

  async assignTicket(ticketKey: string, accountId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({ fields: { assignee: { accountId } } }),
    });
  }

  async addComment(
    ticketKey: string,
    bodyAdf: Record<string, unknown>,
  ): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: bodyAdf }),
    });
  }

  async closeTicket(ticketKey: string): Promise<CloseTicketResult> {
    const statusResponse = await this.request(
      `/rest/api/3/issue/${ticketKey}?fields=status`,
    );
    const statusData = (await statusResponse.json()) as JiraStatusFieldResponse;
    if (statusData.fields.status.statusCategory.key === "done") {
      return { result: "already-done" };
    }

    const transitionsResponse = await this.request(
      `/rest/api/3/issue/${ticketKey}/transitions`,
    );
    const transitionsData = (await transitionsResponse.json()) as JiraTransitionsResponse;
    const doneTransition = transitionsData.transitions.find(
      (t) => t.to.statusCategory.key === "done",
    );
    if (!doneTransition) {
      return { result: "no-transition" };
    }

    await this.request(`/rest/api/3/issue/${ticketKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: doneTransition.id } }),
    });
    return { result: "closed", transitionName: doneTransition.to.name };
  }
}
