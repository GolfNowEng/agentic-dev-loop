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
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: { refine: 'labels = "{label}"', dev: 'labels = "{label}"' },
      ...overrides,
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
    github: { repo: "fandango/webtarsthree" },
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
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const ticket = await client.pollOldestMatching("labels = pipeline:dev");

    expect(ticket).toEqual({
      key: "PROJ-1",
      status: "Backlog",
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

  it("swapLabel PUTs the labels field with a remove/add op pair", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    await client.swapLabel("PROJ-1", "pipeline:research", "pipeline:dev");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      update: {
        labels: [{ remove: "pipeline:research" }, { add: "pipeline:dev" }],
      },
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

  it("closeTicket returns 'already-done' without calling transitions when the ticket's current status is already in the done category", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fields: { status: { name: "Closed", statusCategory: { key: "done" } } },
        }),
        { status: 200 },
      ),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "already-done" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://example.atlassian.net/rest/api/3/issue/PROJ-1?fields=status",
    );
  });

  it("closeTicket transitions to the first done-category transition and reports its name", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "To Do", statusCategory: { key: "new" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "41", to: { name: "Blocked", statusCategory: { key: "new" } } },
              { id: "201", to: { name: "Close", statusCategory: { key: "done" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "closed", transitionName: "Close" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, postInit] = fetchMock.mock.calls[2];
    expect(postInit.method).toBe("POST");
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "201" },
    });
  });

  it("closeTicket picks the FIRST done-category transition when multiple are offered", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "10", to: { name: "Won't Do", statusCategory: { key: "done" } } },
              { id: "20", to: { name: "Done", statusCategory: { key: "done" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "closed", transitionName: "Won't Do" });
    const [, postInit] = fetchMock.mock.calls[2];
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: "10" },
    });
  });

  it("closeTicket returns 'no-transition' when the ticket isn't done and no done-category transition is offered, and no single forward-progress hop is available either", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "41", to: { name: "Blocked", statusCategory: { key: "new" } } },
            ],
          }),
          { status: 200 },
        ),
      );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "no-transition" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closeTicket hops through a single unambiguous forward-progress transition when no done-category transition is offered directly", async () => {
    fetchMock
      // 1. current status: Code Review, not done
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      // 2. transitions from Code Review: no done-category, but exactly one
      //    forward-progress-looking hop ("Review Complete" -> "Development Complete")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "41", to: { name: "Blocked", statusCategory: { key: "new" } } },
              { id: "271", to: { name: "Review Complete", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      // 3. POST the hop transition
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // 4. transitions from the new status (Development Complete): one done-category
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "300", to: { name: "Closed", statusCategory: { key: "done" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      // 5. POST the done transition
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({
      result: "closed",
      transitionName: "Review Complete -> Closed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const [, hopInit] = fetchMock.mock.calls[2];
    expect(JSON.parse(hopInit.body as string)).toEqual({ transition: { id: "271" } });
    const [, doneInit] = fetchMock.mock.calls[4];
    expect(JSON.parse(doneInit.body as string)).toEqual({ transition: { id: "300" } });
  });

  it("closeTicket refuses to hop when more than one forward-progress-looking transition is offered (never guesses)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "271", to: { name: "Review Complete", statusCategory: { key: "indeterminate" } } },
              { id: "272", to: { name: "Ready for Release", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "no-transition" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closeTicket does not hop through a transition that looks like a step backward (Blocked/Rejected/Reopened)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "41", to: { name: "Blocked", statusCategory: { key: "new" } } },
              { id: "131", to: { name: "Rejected", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "no-transition" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("closeTicket does not hop more than once (only a single intermediate hop is attempted)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fields: { status: { name: "Code Review", statusCategory: { key: "indeterminate" } } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "271", to: { name: "Review Complete", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // After hopping to "Review Complete", still no done-category transition,
      // and still only another indeterminate hop available -- must NOT chain
      // a second hop, must report no-transition instead.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [
              { id: "500", to: { name: "Ready for Deploy", statusCategory: { key: "indeterminate" } } },
            ],
          }),
          { status: 200 },
        ),
      );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const result = await client.closeTicket("PROJ-1");

    expect(result).toEqual({ result: "no-transition" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("RealJiraClient.pollAllMatching", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns every matching ticket, not just the oldest", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                status: { name: "Code Review" },
                assignee: { accountId: "user-123" },
              },
            },
            {
              key: "PROJ-2",
              fields: {
                status: { name: "Code Review" },
                assignee: null,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const tickets = await client.pollAllMatching('labels = "pipeline:dev"');

    expect(tickets).toEqual([
      { key: "PROJ-1", status: "Code Review", assignee: "user-123" },
      { key: "PROJ-2", status: "Code Review", assignee: null },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/search/jql");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      jql: 'labels = "pipeline:dev"',
      fields: ["status", "assignee"],
    });
  });

  it("returns an empty array when nothing matches", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [] }), { status: 200 }),
    );
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const tickets = await client.pollAllMatching('labels = "pipeline:dev"');

    expect(tickets).toEqual([]);
  });
});
