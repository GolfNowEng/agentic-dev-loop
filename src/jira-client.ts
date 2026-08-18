/**
 * Jira access boundary for the research-loop.
 *
 * loop-runner.ts depends only on the JiraClient interface, never on a
 * concrete implementation -- tests inject a mock, and production wiring
 * uses RealJiraClient (REST-backed) once Appendix A of the pipeline spec
 * is filled in.
 */

import type { Config } from "./types.js";

/**
 * Minimal description of a Jira ticket as the loop needs it. Kept narrow
 * deliberately -- the loop should not need full Jira field fidelity.
 */
export interface JiraTicket {
  key: string;
  status: string;
  epic: string | null;
  labels: string[];
}

export interface JiraClient {
  /**
   * Poll Jira via the given JQL and return the oldest matching ticket, or
   * null if nothing matches.
   */
  pollOldestMatching(jql: string): Promise<JiraTicket | null>;

  /**
   * Attempt to claim a ticket by transitioning it from claimStatus.from to
   * claimStatus.to. Returns true if the claim succeeded, false if it lost
   * a race (another process already transitioned it away from `from`) --
   * callers must treat false as "skip this ticket," never as an error to
   * throw.
   */
  claim(ticketKey: string, from: string, to: string): Promise<boolean>;

  /** Transition a ticket to the given status. */
  transitionStatus(ticketKey: string, toStatus: string): Promise<void>;

  /** Move a ticket to a different epic. */
  moveToEpic(ticketKey: string, epicKey: string): Promise<void>;
}

const UNCONFIGURED_MESSAGE = (method: string): string =>
  `JiraClient.${method}: Jira instance is not configured. ` +
  `Appendix A of the pipeline spec (pipeline.config.json epic IDs, ` +
  `statuses, and JQL) is still unfilled -- this needs real Jira binding ` +
  `values before any Jira call can be made.`;

/**
 * Placeholder JiraClient. Every method throws until pipeline.config.json's
 * "___" placeholders are replaced with real Jira values and a real client
 * is wired in. Exists so loop-runner.ts has something concrete to run
 * against outside of tests without silently pretending to talk to Jira.
 */
export class StubJiraClient implements JiraClient {
  async pollOldestMatching(_jql: string): Promise<JiraTicket | null> {
    throw new Error(UNCONFIGURED_MESSAGE("pollOldestMatching"));
  }

  async claim(_ticketKey: string, _from: string, _to: string): Promise<boolean> {
    throw new Error(UNCONFIGURED_MESSAGE("claim"));
  }

  async transitionStatus(_ticketKey: string, _toStatus: string): Promise<void> {
    throw new Error(UNCONFIGURED_MESSAGE("transitionStatus"));
  }

  async moveToEpic(_ticketKey: string, _epicKey: string): Promise<void> {
    throw new Error(UNCONFIGURED_MESSAGE("moveToEpic"));
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
      labels: string[];
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
  constructor(
    private readonly credentials: JiraCredentials,
    private readonly config: Config,
  ) {}

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
    const response = await this.request("/rest/api/3/search", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults: 1,
        fields: ["status", "labels", this.config.jira.epicLinkField].filter(
          (f) => f !== "___",
        ),
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
      labels: issue.fields.labels ?? [],
    };
  }

  async claim(ticketKey: string, from: string, to: string): Promise<boolean> {
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

  async transitionStatus(ticketKey: string, toStatus: string): Promise<void> {
    const response = await this.request(`/rest/api/3/issue/${ticketKey}/transitions`);
    const data = (await response.json()) as JiraTransitionsResponse;
    const transition = data.transitions.find((t) => t.to.name === toStatus);
    if (!transition) {
      throw new Error(
        `RealJiraClient.transitionStatus: no transition to status "${toStatus}" is ` +
          `available for ${ticketKey} from its current status.`,
      );
    }
    await this.request(`/rest/api/3/issue/${ticketKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
  }

  async moveToEpic(ticketKey: string, epicKey: string): Promise<void> {
    const field = this.epicLinkField();
    await this.request(`/rest/api/3/issue/${ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({ fields: { [field]: epicKey } }),
    });
  }
}
