import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RealJiraClient,
  credentialsFromEnv,
  type JiraCredentials,
} from "../src/jira-client.ts";
import type { Config } from "../src/types.ts";

function makeConfig(overrides: Partial<Config["jira"]> = {}): Config {
  return {
    jira: {
      intakeEpics: ["EPIC-1"],
      reviewEpic: "EPIC-REVIEW",
      readyEpic: "EPIC-READY",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: { refine: "epic in ({epics})", dev: "epic = {epic}" },
      epicLinkField: "customfield_10014",
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
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
                labels: ["auto-promote"],
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
      labels: ["auto-promote"],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/search/jql");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("bot@example.com:fake-token").toString("base64")}`,
    );
  });

  it("pollOldestMatching returns null when no issues match", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [] }), { status: 200 }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const ticket = await client.pollOldestMatching("epic in (EPIC-1)");
    expect(ticket).toBeNull();
  });

  it("claim returns false (never throws) when the target transition is unavailable -- a race", async () => {
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
        claimed = await client.claim("PROJ-1", "Backlog", "In Progress");
      })(),
    ).resolves.not.toThrow();

    expect(claimed).toBe(false);
    // Only the GET to list transitions should have happened -- no POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("claim posts the matching transition and returns true on success", async () => {
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
    const claimed = await client.claim("PROJ-1", "Backlog", "In Progress");

    expect(claimed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, postInit] = fetchMock.mock.calls[1];
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "42" },
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

  it("moveToEpic PUTs the configured epicLinkField with the epic key", async () => {
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

  it("throws a descriptive error when a request fails with a non-OK status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    await expect(client.pollOldestMatching("epic in (EPIC-1)")).rejects.toThrow(
      /401/,
    );
  });
});
