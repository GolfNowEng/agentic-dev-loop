import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RealJiraClient,
  credentialsFromEnv,
  assigneeAccountIdFromEnv,
  type JiraCredentials,
} from "../src/jira-client.ts";
import type { Config } from "../src/types.ts";

function makeConfig(overrides: Partial<Config["jira"]> = {}): Config {
  return {
    jira: {
      intakeEpics: ["EPIC-1"],
      readyEpic: "EPIC-READY",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: { refine: "epic in ({epics})", dev: "epic = {epic}" },
      epicLinkField: "customfield_10014",
      ...overrides,
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}

const CREDENTIALS: JiraCredentials = {
  baseUrl: "https://example.atlassian.net",
  email: "bot@example.com",
  apiToken: "fake-token",
};

describe("credentialsFromEnv", () => {
  it("reads all three vars when present", () => {
    const creds = credentialsFromEnv({
      JIRA_BASE_URL: "https://x.atlassian.net",
      JIRA_EMAIL: "a@b.com",
      JIRA_API_TOKEN: "tok",
    } as NodeJS.ProcessEnv);
    expect(creds).toEqual({
      baseUrl: "https://x.atlassian.net",
      email: "a@b.com",
      apiToken: "tok",
    });
  });

  it("throws naming every missing var", () => {
    expect(() => credentialsFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /JIRA_BASE_URL.*JIRA_EMAIL.*JIRA_API_TOKEN/s,
    );
  });
});

describe("assigneeAccountIdFromEnv", () => {
  it("returns the value when present", () => {
    const accountId = assigneeAccountIdFromEnv({
      JIRA_ASSIGNEE_ACCOUNT_ID: "user-123",
    } as NodeJS.ProcessEnv);
    expect(accountId).toBe("user-123");
  });

  it("throws when missing", () => {
    expect(() => assigneeAccountIdFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /JIRA_ASSIGNEE_ACCOUNT_ID/,
    );
  });
});

describe("RealJiraClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pollOldestMatching sends Basic auth and parses the first issue", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                status: { name: "Backlog" },
                assignee: { accountId: "user-123" },
                customfield_10014: "EPIC-1",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const ticket = await client.pollOldestMatching("epic in (EPIC-1)");

    expect(ticket).toEqual({
      key: "PROJ-1",
      status: "Backlog",
      epic: "EPIC-1",
      assignee: "user-123",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/search/jql");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("bot@example.com:fake-token").toString("base64")}`,
    );
    expect(JSON.parse(init.body as string).fields).toContain("assignee");
  });

  it("pollOldestMatching maps a null assignee to null (unassigned ticket)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issues: [
            {
              key: "PROJ-2",
              fields: {
                status: { name: "Backlog" },
                assignee: null,
                customfield_10014: "EPIC-1",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const ticket = await client.pollOldestMatching("epic in (EPIC-1)");

    expect(ticket?.assignee).toBeNull();
  });

  it("pollOldestMatching returns null when no issues match", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [] }), { status: 200 }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const ticket = await client.pollOldestMatching("epic in (EPIC-1)");
    expect(ticket).toBeNull();
  });

  it("claimTicket returns false (never throws) when the target transition is unavailable -- a race", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ transitions: [{ id: "1", to: { name: "Done" } }] }),
        { status: 200 },
      ),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    let claimed: boolean | undefined;
    await expect(
      (async () => {
        claimed = await client.claimTicket("PROJ-1", "Backlog", "In Progress");
      })(),
    ).resolves.not.toThrow();

    expect(claimed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("claimTicket posts the matching transition and returns true on success", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [{ id: "42", to: { name: "In Progress" } }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const claimed = await client.claimTicket("PROJ-1", "Backlog", "In Progress");

    expect(claimed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, postInit] = fetchMock.mock.calls[1];
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "42" },
    });
  });

  it("transitionStatus posts the given fields alongside the transition, when provided", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [{ id: "21", to: { name: "Code Review" } }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await client.transitionStatus("PROJ-1", "Code Review", {
      customfield_13504: [{ id: "14310" }],
      customfield_14226: "PR: https://github.com/org/repo/pull/1",
    });

    const [, postInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "21" },
      fields: {
        customfield_13504: [{ id: "14310" }],
        customfield_14226: "PR: https://github.com/org/repo/pull/1",
      },
    });
  });

  it("transitionStatus omits the fields key entirely when no fields are given", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ transitions: [{ id: "31", to: { name: "Blocked" } }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await client.transitionStatus("PROJ-1", "Blocked");

    const [, postInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "31" },
    });
  });

  it("moveToEpic throws a clear error when epicLinkField is still the placeholder", async () => {
    const client = new RealJiraClient(
      CREDENTIALS,
      makeConfig({ epicLinkField: "___" }),
    );
    await expect(client.moveToEpic("PROJ-1", "EPIC-READY")).rejects.toThrow(
      /epicLinkField is not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moveToEpic PUTs the configured custom-field epicLinkField with a bare epic key string", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    await client.moveToEpic("PROJ-1", "EPIC-READY");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      fields: { customfield_10014: "EPIC-READY" },
    });
  });

  it("moveToEpic PUTs the parent field as an object ({ key }), not a bare string -- Jira's own parent field requires this shape (team-managed projects)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(
      CREDENTIALS,
      makeConfig({ epicLinkField: "parent" }),
    );

    await client.moveToEpic("PROJ-1", "EPIC-READY");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      fields: { parent: { key: "EPIC-READY" } },
    });
  });

  it("assignTicket PUTs the assignee field with the given accountId", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    await client.assignTicket("PROJ-1", "user-123");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      fields: { assignee: { accountId: "user-123" } },
    });
  });

  it("throws a descriptive error when a request fails with a non-OK status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await expect(client.pollOldestMatching("epic in (EPIC-1)")).rejects.toThrow(
      /401/,
    );
  });

  it("addComment POSTs the given ADF body to the issue's comment endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const bodyAdf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Bounced." }] }],
    };
    await client.addComment("PROJ-1", bodyAdf);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://example.atlassian.net/rest/api/3/issue/PROJ-1/comment",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ body: bodyAdf });
  });
});
