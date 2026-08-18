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
  epic: string | null;
}

export interface JiraClient {
  /**
   * Poll Jira for the oldest ticket matching the given JQL. Returns null
   * if no ticket matches.
   */
  pollOldestMatching(jql: string): Promise<JiraTicket | null>;

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
   * moving it toward "landed").
   */
  transitionStatus(ticketKey: string, to: string): Promise<void>;

  /**
   * Move a ticket to a different epic (e.g. from an intake epic to the
   * review epic, or from the review epic to the ready epic).
   */
  moveToEpic(ticketKey: string, epic: string): Promise<void>;
}

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

  async claimTicket(
    _ticketKey: string,
    _from: string,
    _to: string,
  ): Promise<boolean> {
    throw StubJiraClient.notConfigured("claimTicket");
  }

  async transitionStatus(_ticketKey: string, _to: string): Promise<void> {
    throw StubJiraClient.notConfigured("transitionStatus");
  }

  async moveToEpic(_ticketKey: string, _epic: string): Promise<void> {
    throw StubJiraClient.notConfigured("moveToEpic");
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

interface JiraSearchResponse {
  issues: Array<{
    key: string;
    fields: {
      status: { name: string };
      [key: string]: unknown;
    };
  }>;
}

interface JiraTransitionsResponse {
  transitions: Array<{ id: string; to: { name: string } }>;
}

/**
 * REST-backed JiraClient for Jira Cloud, authenticated via HTTP Basic auth
 * (email + API token) per Atlassian's documented auth scheme for the v3
 * REST API. `config.jira.epicLinkField` selects how epic membership is
 * read/written: the literal string "parent" (team-managed projects) or a
 * custom field id such as "customfield_10014" (company-managed projects).
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

  private epicLinkField(): string {
    const field = this.config.jira.epicLinkField;
    if (field === "___") {
      throw new Error(
        "RealJiraClient: jira.epicLinkField is not configured in pipeline.config.json " +
          '(still the placeholder "___"). Set it to "parent" (team-managed projects) or ' +
          'a custom field id such as "customfield_10014" (company-managed projects).',
      );
    }
    return field;
  }

  async pollOldestMatching(jql: string): Promise<JiraTicket | null> {
    const response = await this.request("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults: 1,
        fields: ["status", this.config.jira.epicLinkField].filter((f) => f !== "___"),
      }),
    });
    const data = (await response.json()) as JiraSearchResponse;
    const issue = data.issues[0];
    if (!issue) return null;

    const epicField = this.config.jira.epicLinkField;
    const epic =
      epicField !== "___" ? (issue.fields[epicField] as string | null) ?? null : null;

    return {
      key: issue.key,
      status: issue.fields.status.name,
      epic,
    };
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

  async transitionStatus(ticketKey: string, to: string): Promise<void> {
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
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
  }

  async moveToEpic(ticketKey: string, epic: string): Promise<void> {
    const field = this.epicLinkField();
    await this.request(`/rest/api/3/issue/${ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({ fields: { [field]: epic } }),
    });
  }
}
