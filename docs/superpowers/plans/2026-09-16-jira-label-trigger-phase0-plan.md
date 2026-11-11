# Jira Label-Based Trigger — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the epic-parent Jira trigger with a label-based trigger in
both `research-loop` and `dev-loop`, landing together in one pass, per the
approved Phase 0 design spec.

**Architecture:** `Config.jira` drops `intakeEpics`/`readyEpic`/
`epicLinkField` and gains two plain strings, `triggerLabel`/`handoffLabel`.
`src/jql.ts` in both repos swaps its `{epics}`/`{epic}`/`{readyEpic}`
placeholders for a single `{label}` placeholder. `JiraClient.moveToEpic` is
replaced by `JiraClient.swapLabel(ticketKey, from, to)`, implemented as one
Jira `PUT` using the `update.labels` array-of-ops shape. research-loop's
`runLoopIteration` calls `swapLabel` in the exact same `autoPromoteLabel`-
gated spot `moveToEpic` used to occupy. dev-loop's `decideEpicMove` and its
one live branch are deleted outright (a landed dev-loop verdict already
never moved anything); `LoopKind`/the `loopKind === "refine"` branch stay
untouched. `JiraTicket.epic` is deleted from both repos.

**Tech Stack:** TypeScript (Node's built-in type-stripping, no build step
for running `src/*.ts` directly), Vitest, `vi.stubGlobal("fetch", ...)` for
`RealJiraClient` tests.

**Spec:** `docs/superpowers/specs/2026-09-15-jira-label-trigger-phase0-design.md`
(research-loop, commit `8ad6e2c`) — the source of truth for every design
decision below. This plan sequences that spec into tasks; it does not
re-derive any of its reasoning.

## Global Constraints

- Both repos move together in one pass — do not land research-loop's half
  without dev-loop's, or vice versa.
- TDD, strictly, per each repo's own `CLAUDE.md`: write the RED test first,
  confirm it fails, then implement, then confirm green. `npm test` must be
  green in each repo before task 1 starts and after every task.
- Read `docs/config.md` (each repo) before touching `src/config.ts`,
  `Config`'s shape, or `pipeline.*.config.json` — done during planning;
  carry its content forward, don't re-read reflexively mid-task.
- Read `docs/skills.md` (each repo) before touching
  `.claude/skills/ticket-refine/SKILL.md` (research-loop) or
  `.claude/skills/ticket-to-pr/SKILL.md` (dev-loop) — same, already read.
- research-loop's label swap in `loop-runner.ts` stays gated by the exact
  same `autoPromoteLabel`-present check used by today's epic-move — never
  made automatic by default.
- dev-loop's `decideEpicMove` and its `readyEpic`-returning branch are
  deleted outright, not stubbed or deprecated. `LoopKind` and the
  `loopKind === "refine"` branch in `runLoopIteration` stay.
- `research-loop/pipeline.webtarsthree.config.json` currently carries an
  uncommitted, unrelated diff: `ceilings.maxCostPerRunUsd` 20→50,
  `ceilings.runTimeoutMin` 45→120. Preserve those two values exactly
  (`50`, `120`) when editing this file — do not revert them.
- Out of scope, do not implement: status labels (`pipeline:blocked`,
  `pipeline:pr-open`, etc.), GitHub Issues/dual-write, dev-loop reading from
  GitHub, backfilling real Jira tickets in `TARS-1350`/`TARS-1384`.
- `dev-loop`'s working tree has two pre-existing uncommitted files unrelated
  to this change (`.claude/skills/ticket-to-pr/SKILL.md`,
  `CHANGELOG.md` — a `COMMIT_TYPE`/conventional-commit fix). Every edit
  this plan makes to those two files is additive to what's already
  uncommitted there; do not `git checkout`/discard the existing diff.

---

## File map

**research-loop** (`/Users/206618626@bwt3.com/Desktop/Repos/research-loop`):

| File | Change |
|---|---|
| `src/types.ts` | `Config.jira`: delete `intakeEpics`/`readyEpic`/`epicLinkField`, add `triggerLabel`/`handoffLabel` |
| `src/jira-client.ts` | Delete `JiraTicket.epic`; replace `moveToEpic` with `swapLabel` on `JiraClient`, `StubJiraClient`, `RealJiraClient` |
| `src/jql.ts` | `buildRefineJql`/`buildDevJql`: substitute `{label}` from `triggerLabel`/`handoffLabel` |
| `src/config.ts` | `PLACEHOLDER_PATHS`: swap `jira.readyEpic`/`jira.epicLinkField` for `jira.triggerLabel`/`jira.handoffLabel` |
| `src/loop-runner.ts` | Landed+autoPromoteLabel branch calls `swapLabel` instead of `moveToEpic` |
| `test/jql.test.ts` | Rewrite epic-substitution assertions as label-substitution |
| `test/config.test.ts` | Rewrite placeholder-path assertions |
| `test/jira-client.test.ts` | Delete `moveToEpic` tests, add `swapLabel` tests |
| `test/loop-runner.test.ts` | Rewrite `moveToEpic` assertions as `swapLabel` assertions |
| `test/ceilings.test.ts` | Update inline `Config` literal's `jira` shape (Task 1) |
| `pipeline.webtarsthree.config.json` | Replace epic fields with label fields; preserve uncommitted ceilings diff |
| `docs/config.md` | Per spec's "Docs to update" section |
| `README.md` | Line ~29 label-swap rephrase |
| `.claude/skills/ticket-refine/SKILL.md` | Step 0 and Step 7 epic language → label language |
| `docs/future-enhancements.md` | Trim Phase 0 rollout bullet as done |
| `CHANGELOG.md` | New entry |

**dev-loop** (`/Users/206618626@bwt3.com/Desktop/repos/dev-loop`):

| File | Change |
|---|---|
| `src/types.ts` | `Config.jira` (via `JiraConfig`): same field swap as research-loop |
| `src/jira-client.ts` | Delete `JiraTicket.epic`; replace `moveToEpic` with `swapLabel` |
| `src/jql.ts` | `buildRefineJql`/`buildDevJql`: `{label}` substitution; `buildDevJql` keeps `{assignee}` + its second argument |
| `src/config.ts` | `PLACEHOLDER_PATHS` swap |
| `src/loop-runner.ts` | Delete `decideEpicMove` outright and its one call site; keep `LoopKind`/`loopKind === "refine"` branch |
| `test/jql.test.ts` | Label-substitution rewrite; confirm dropped `status = "In Progress"` clause; confirm `{assignee}` still works |
| `test/config.test.ts` | Placeholder-path rewrite |
| `test/jira-client.test.ts` | `moveToEpic`→`swapLabel` PUT-shape swap |
| `test/loop-runner.test.ts` | Delete `decideEpicMove`-named tests and `moveToEpic`-not-called assertions sprinkled through other tests; update inline `Config` literals |
| `pipeline.webtarsthree.config.json` | Replace epic fields with label fields (no unrelated diff to preserve here) |
| `docs/config.md` | Per spec's "Docs to update" section, including the kept "A landed dev-loop verdict never moves the epic" section (heading/narrative kept, vocabulary updated) |
| `docs/skills.md` | Line ~98 epic-move-decision sentence rephrase |
| `.claude/skills/ticket-to-pr/SKILL.md` | Line ~164 "Ready epic" reference → `pipeline:dev` label (additive to the existing uncommitted diff in this file) |
| `CHANGELOG.md` | New entry (additive to the existing uncommitted diff in this file) |

---

## Task 1 (research-loop): `Config.jira` shape — `triggerLabel`/`handoffLabel`

**Files:**
- Modify: `src/types.ts:113-154` (the `Config.jira` interface)
- Modify: `src/config.ts:53-66` (`PLACEHOLDER_PATHS`)
- Test: `test/config.test.ts`
- Test: `test/ceilings.test.ts` (inline `Config` literal only — no behavior
  change; `checkCeilings`/`assertWithinCeilings` don't read `jira` at all,
  but this file's `makeConfig()` builds a full `Config` object, so it stops
  type-checking the moment `Config.jira` drops the old fields)

**Interfaces:**
- Produces: `Config["jira"]` now has `triggerLabel: string` and
  `handoffLabel: string` in place of `intakeEpics: string[]`,
  `readyEpic: string`, `epicLinkField: string`. `claimStatus`,
  `pollJql.{refine,dev}`, `statusNames` are unchanged in shape.

- [ ] **Step 1: Write the failing test** — replace `test/config.test.ts`'s
  `makeConfig()` helper's `jira` block and the two `findPlaceholders`
  assertions to use the new field names:

```typescript
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "To Do", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" ORDER BY created ASC',
        dev: 'labels = "{label}" ORDER BY created ASC',
      },
      statusNames: { bounced: "Blocked", prOpen: "Code Review" },
      ...overrides.jira,
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 45 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:fandango/webtarsthree.git", defaultBranch: "master" },
    ...overrides,
  };
}
```

  and update the `loadConfig` test's assertion (currently
  `expect(config.jira.readyEpic).toBe("EPIC-READY")`) to:

```typescript
  it("reads and parses a config file at the given path", async () => {
    const filePath = path.join(dir, "pipeline.webtarsthree.config.json");
    await fs.writeFile(filePath, JSON.stringify(makeConfig()), "utf8");
    const config = await loadConfig(filePath);
    expect(config.targetRepo.url).toBe("git@github.com:fandango/webtarsthree.git");
    expect(config.jira.handoffLabel).toBe("pipeline:dev");
  });
```

  and the `findPlaceholders`/`assertNoPlaceholders` block's `readyEpic`/
  `epicLinkField` override to:

```typescript
  it("lists every field still set to the placeholder value", () => {
    const config = makeConfig({
      jira: { ...makeConfig().jira, triggerLabel: "___", handoffLabel: "___" },
    });
    const missing = findPlaceholders(config);
    expect(missing).toContain("jira.triggerLabel");
    expect(missing).toContain("jira.handoffLabel");
  });
```

  Also update `test/ceilings.test.ts`'s `makeConfig()` helper's `jira`
  block (this file only exercises `checkCeilings`/`assertWithinCeilings`,
  neither of which reads `jira`, but the helper builds a full `Config`
  object so it stops compiling once `Config.jira` drops the old fields):

```typescript
function makeConfig(overrides: Partial<Config["ceilings"]> = {}): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: { refine: 'labels = "{label}"', dev: 'labels = "{label}"' },
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
    },
    ceilings: {
      maxRunsPerDay: 10,
      maxCostPerRunUsd: 5,
      runTimeoutMin: 30,
      ...overrides,
    },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config.test.ts test/ceilings.test.ts`
Expected: FAIL — `Config`'s `jira` type has no `triggerLabel`/`handoffLabel`
(a TS type error caught by vitest's transform, or a runtime property
mismatch), and the old fields are still required by the type. Both files
fail for the same underlying reason.

- [ ] **Step 3: Update `src/types.ts`'s `Config.jira`**

Replace lines 113-154's `jira` block. Delete the `intakeEpics`,
`readyEpic`, and `epicLinkField` fields (and their doc comments) and add
`triggerLabel`/`handoffLabel` in their place:

```typescript
  jira: {
    /**
     * The label this repo's own poll matches on -- "pipeline:research".
     * Mutually exclusive with handoffLabel: a ticket carries exactly one
     * pipeline-stage label at a time.
     */
    triggerLabel: string;
    /**
     * The label a passing, human-approved (or autoPromoteLabel-gated)
     * verdict swaps a ticket to, handing it off to dev-loop --
     * "pipeline:dev". Carried here for config-shape symmetry with
     * dev-loop's own Config, even though only this repo's loop-runner.ts
     * performs the swap in Phase 0.
     */
    handoffLabel: string;
    claimStatus: {
      from: string;
      to: string;
    };
    pollJql: {
      /** JQL template for the research-loop (refine/skeptic) poll. */
      refine: string;
      /** JQL template for the dev-loop poll. */
      dev: string;
    };
    /**
     * Which existing Jira status names the loop runner's terminal outcomes
     * map onto -- this Jira instance has no literal "bounced" or "pr-open"
     * status, so these must be bound to whatever statuses actually exist in
     * the ticket's workflow (e.g. "Blocked" for bounced, "In Progress" for
     * pr-open).
     */
    statusNames: {
      bounced: string;
      prOpen: string;
    };
  };
```

- [ ] **Step 4: Update `src/config.ts`'s `PLACEHOLDER_PATHS`**

In `PLACEHOLDER_PATHS` (lines 54-66), replace:

```typescript
  ["jira.readyEpic", (c) => c.jira.readyEpic],
```

and

```typescript
  ["jira.epicLinkField", (c) => c.jira.epicLinkField],
```

with:

```typescript
  ["jira.triggerLabel", (c) => c.jira.triggerLabel],
  ["jira.handoffLabel", (c) => c.jira.handoffLabel],
```

(Keep every other entry — `claimStatus.from/to`, `pollJql.refine/dev`,
`statusNames.bounced/prOpen`, `autoPromoteLabel`, `targetRepo.url`,
`targetRepo.defaultBranch` — unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/config.test.ts test/ceilings.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts test/ceilings.test.ts
git commit -m "feat(config): replace jira.intakeEpics/readyEpic/epicLinkField with triggerLabel/handoffLabel"
```

---

## Task 2 (research-loop): `src/jql.ts` — `{label}` substitution

**Files:**
- Modify: `src/jql.ts` (both builders)
- Test: `test/jql.test.ts`

**Interfaces:**
- Consumes: `Config["jira"]["triggerLabel"]`/`["handoffLabel"]` (Task 1).
- Produces: `buildRefineJql(config: Config): string`,
  `buildDevJql(config: Config): string` — same signatures as today, new
  substitution source.

- [ ] **Step 1: Write the failing test** — replace `test/jql.test.ts` in full:

```typescript
import { describe, it, expect } from "vitest";
import { buildRefineJql, buildDevJql } from "../src/jql.ts";
import type { Config } from "../src/types.ts";

function makeConfig(): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" AND status = "Backlog" ORDER BY created ASC',
        dev: 'labels = "{label}" ORDER BY created ASC',
      },
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}

describe("buildRefineJql", () => {
  it("substitutes triggerLabel into the refine template", () => {
    const jql = buildRefineJql(makeConfig());
    expect(jql).toContain("pipeline:research");
    expect(jql).not.toContain("{label}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    const jql = buildRefineJql(makeConfig());
    expect(jql).toContain("ORDER BY created ASC");
  });
});

describe("buildDevJql", () => {
  it("substitutes handoffLabel into the dev template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("pipeline:dev");
    expect(jql).not.toContain("{label}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("ORDER BY created ASC");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/jql.test.ts`
Expected: FAIL — `buildRefineJql`/`buildDevJql` still read
`intakeEpics`/`readyEpic`, which no longer exist on `Config["jira"]`
(type error) and the templates use `{epics}`/`{epic}` in the old test's
shape, not `{label}`.

- [ ] **Step 3: Implement** — replace `src/jql.ts` in full:

```typescript
/**
 * Builds resolved JQL strings from a Config's pollJql templates plus the
 * jira.triggerLabel / jira.handoffLabel this repo's Config carries.
 *
 * The refine loop polls tickets carrying triggerLabel (candidates for the
 * skeptic pass). The dev loop polls tickets carrying handoffLabel
 * (candidates for dev-loop to pick up).
 */

import type { Config } from "./types.ts";

/**
 * Build the JQL for the research-loop's own (refine/skeptic) poll, using
 * config.jira.pollJql.refine as a template and config.jira.triggerLabel as
 * the label to match.
 */
export function buildRefineJql(config: Config): string {
  return config.jira.pollJql.refine.replace("{label}", config.jira.triggerLabel);
}

/**
 * Build the JQL for the dev-loop's poll, using config.jira.pollJql.dev as
 * a template and config.jira.handoffLabel as the label to match.
 *
 * research-loop does not run this poll itself, but owns the config shape
 * dev-loop reads it from, so the builder lives here for symmetry and
 * testability.
 */
export function buildDevJql(config: Config): string {
  return config.jira.pollJql.dev.replace("{label}", config.jira.handoffLabel);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/jql.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jql.ts test/jql.test.ts
git commit -m "feat(jql): swap {epics}/{epic} template placeholders for {label}"
```

---

## Task 3 (research-loop): `JiraClient.swapLabel` replaces `moveToEpic`

**Files:**
- Modify: `src/jira-client.ts` (interface, `StubJiraClient`, `RealJiraClient`; delete `JiraTicket.epic`)
- Test: `test/jira-client.test.ts`

**Interfaces:**
- Produces: `JiraClient.swapLabel(ticketKey: string, from: string, to: string): Promise<void>`,
  replacing `moveToEpic(ticketKey: string, epicKey: string): Promise<void>`.
  `JiraTicket` no longer has an `epic` field.

- [ ] **Step 1: Write the failing test** — in `test/jira-client.test.ts`,
  update `makeConfig()` (lines 10-25) to the new `jira` shape:

```typescript
function makeConfig(overrides: Partial<Config["jira"]> = {}): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: { refine: 'labels = "{label}"', dev: 'labels = "{label}"' },
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
      ...overrides,
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}
```

  Update `pollOldestMatching`'s two tests (currently asserting
  `epic: "EPIC-1"` from a `customfield_10014` response field) to drop the
  epic field entirely — `pollOldestMatching`'s first test becomes:

```typescript
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
                assignee: { accountId: "user-123" },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const client = new RealJiraClient(CREDENTIALS, makeConfig());
    const ticket = await client.pollOldestMatching("labels = pipeline:research");

    expect(ticket).toEqual({
      key: "PROJ-1",
      status: "Backlog",
      labels: ["auto-promote"],
      assignee: "user-123",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.atlassian.net/rest/api/3/search/jql");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("bot@example.com:fake-token").toString("base64")}`,
    );
    expect(JSON.parse(init.body as string).fields).toContain("assignee");
  });
```

  and the second (`pollOldestMatching maps a null assignee to null`) drops
  its `customfield_10014: "EPIC-1"` field from the mocked response body
  (everything else unchanged).

  Delete the two `moveToEpic` tests (`"moveToEpic throws a clear error
  when epicLinkField is still the placeholder"` and the two PUT-shape
  tests for `customfield_10014` and `parent`) and replace with:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/jira-client.test.ts`
Expected: FAIL — `swapLabel` doesn't exist on `RealJiraClient` yet;
`makeConfig()`'s new shape doesn't type-check against the still-old
`Config["jira"]` interface if Task 1 hasn't landed first (it has, per task
order), so the failure here is purely "no `swapLabel` method."

- [ ] **Step 3: Implement** — in `src/jira-client.ts`:

  a. Delete `epic: string | null;` from the `JiraTicket` interface
  (line 19).

  b. In the `JiraClient` interface, replace:

```typescript
  /** Move a ticket to a different epic. */
  moveToEpic(ticketKey: string, epicKey: string): Promise<void>;
```

  with:

```typescript
  /**
   * Swap a ticket's pipeline-stage label from `from` to `to` in one PUT
   * (Jira's labels field supports a remove/add op pair directly -- no
   * GET-then-merge needed).
   */
  swapLabel(ticketKey: string, from: string, to: string): Promise<void>;
```

  c. In `StubJiraClient`, replace:

```typescript
  async moveToEpic(_ticketKey: string, _epicKey: string): Promise<void> {
    throw new Error(UNCONFIGURED_MESSAGE("moveToEpic"));
  }
```

  with:

```typescript
  async swapLabel(_ticketKey: string, _from: string, _to: string): Promise<void> {
    throw new Error(UNCONFIGURED_MESSAGE("swapLabel"));
  }
```

  d. Delete the `epicLinkField()` private method (lines 195-205) — it has
  no label-equivalent concept and no other caller.

  e. In `pollOldestMatching`, delete the `epicField`/`epic` derivation and
  the `fields` array's `this.config.jira.epicLinkField` entry, and drop
  `epic` from the returned object:

```typescript
  async pollOldestMatching(jql: string): Promise<JiraTicket | null> {
    const response = await this.request("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults: 1,
        fields: ["status", "labels", "assignee"],
      }),
    });
    const data = (await response.json()) as JiraSearchResponse;
    const issue = data.issues[0];
    if (!issue) return null;

    return {
      key: issue.key,
      status: issue.fields.status.name,
      labels: issue.fields.labels ?? [],
      assignee: issue.fields.assignee?.accountId ?? null,
    };
  }
```

  f. Replace `moveToEpic` with `swapLabel`:

```typescript
  async swapLabel(ticketKey: string, from: string, to: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({
        update: { labels: [{ remove: from }, { add: to }] },
      }),
    });
  }
```

  g. Update the class doc comment (lines 151-157) to drop its
  `epicLinkField`-selection sentence — it no longer selects anything:

```typescript
/**
 * REST-backed JiraClient for Jira Cloud, authenticated via HTTP Basic auth
 * (email + API token) per Atlassian's documented auth scheme for the v3
 * REST API.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/jira-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jira-client.ts test/jira-client.test.ts
git commit -m "feat(jira-client): replace moveToEpic with swapLabel; delete JiraTicket.epic"
```

---

## Task 4 (research-loop): `loop-runner.ts` — call `swapLabel` in place of `moveToEpic`

**Files:**
- Modify: `src/loop-runner.ts` (the `outcome === "landed"` branch, ~line 171-181)
- Test: `test/loop-runner.test.ts`

**Interfaces:**
- Consumes: `JiraClient.swapLabel` (Task 3), `Config["jira"]["triggerLabel"]`/
  `["handoffLabel"]` (Task 1).
- Produces: no new exports — `runLoopIteration`'s external behavior/signature
  is unchanged, only its internal Jira call changes.

- [ ] **Step 1: Write the failing test** — in `test/loop-runner.test.ts`:

  a. Update `makeConfig()` (lines 13-32) to the new `jira` shape:

```typescript
function makeConfig(overrides: Partial<Config["ceilings"]> = {}): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: { refine: 'labels = "{label}"', dev: 'labels = "{label}"' },
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
    },
    ceilings: {
      maxRunsPerDay: 100,
      maxCostPerRunUsd: 50,
      runTimeoutMin: 60,
      ...overrides,
    },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}
```

  b. Update `makeTicket()` (lines 35-44) to drop the `epic` field:

```typescript
function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return {
    key: "PROJ-142",
    status: "Backlog",
    labels: [],
    assignee: ASSIGNEE_ACCOUNT_ID,
    ...overrides,
  };
}
```

  c. Update `makeMockJiraClient()` (lines 47-56) to mock `swapLabel`
  instead of `moveToEpic`:

```typescript
function makeMockJiraClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => makeTicket()),
    claim: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => undefined),
    swapLabel: vi.fn(async () => undefined),
    assignTicket: vi.fn(async () => undefined),
    ...overrides,
  };
}
```

  d. In the "a post-run ceiling breach still records..." test (~line
  243-269), replace the `moveToEpic` assertion:

```typescript
    expect(jiraClient.moveToEpic).not.toHaveBeenCalled();
```

  with:

```typescript
    expect(jiraClient.swapLabel).not.toHaveBeenCalled();
```

  e. In "a passing verdict without autoPromoteLabel never moves the
  epic..." (~line 285-302), rename the test and swap its assertion:

```typescript
  it("a passing verdict without autoPromoteLabel never swaps the label -- the ticket stays at triggerLabel, refined, awaiting human approval", async () => {
    const jiraClient = makeMockJiraClient();
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({
        verdictRaw: JSON.stringify({
          outcome: "landed",
          phase_reached: "pr",
          failure_category: null,
          detail: "Refined and ready for human review.",
        }),
      }),
    );
    const config = makeConfig();

    await runLoopIteration(makeDeps({ jiraClient, config, runSkill }));

    expect(jiraClient.swapLabel).not.toHaveBeenCalled();
  });
```

  f. In "a passing verdict with autoPromoteLabel present moves the ticket
  to the ready epic" (~line 304-325), rename and rewrite:

```typescript
  it("a passing verdict with autoPromoteLabel present swaps triggerLabel to handoffLabel", async () => {
    const jiraClient = makeMockJiraClient({
      pollOldestMatching: vi.fn(async () =>
        makeTicket({ key: "PROJ-142", labels: ["auto-promote"] }),
      ),
    });
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({
        verdictRaw: JSON.stringify({
          outcome: "landed",
          phase_reached: "pr",
          failure_category: null,
          detail: "Refined; auto-promoted.",
        }),
      }),
    );
    const config = makeConfig();

    await runLoopIteration(makeDeps({ jiraClient, config, runSkill }));

    expect(jiraClient.swapLabel).toHaveBeenCalledWith(
      "PROJ-142",
      config.jira.triggerLabel,
      config.jira.handoffLabel,
    );
  });
```

  g. In the `outcome: "ready"` test (~line 327-345), swap the assertion:

```typescript
    expect(jiraClient.swapLabel).not.toHaveBeenCalled();
```

  h. In "a bounced verdict sets status bounced..." (~line 347-365), swap:

```typescript
    expect(jiraClient.swapLabel).not.toHaveBeenCalled();
```

  i. Rename and rewrite "a moveToEpic failure..." (~line 367-404):

```typescript
  it("a swapLabel failure (e.g. a malformed Jira request) never throws out of runLoopIteration -- the run still gets logged, and the failure is surfaced via jiraSyncError, not by killing the caller", async () => {
    const jiraClient = makeMockJiraClient({
      // auto-promote label is required to exercise swapLabel at all --
      // a non-auto-promoted landed verdict never calls it (see the
      // "never swaps the label" test above).
      pollOldestMatching: vi.fn(async () =>
        makeTicket({ key: "PROJ-142", labels: ["auto-promote"] }),
      ),
      swapLabel: vi.fn(async () => {
        throw new Error('PUT ... -> 400 Bad Request. {"errors":{"labels":"..."}}');
      }),
    });
    const runSkill: RunSkillFn = vi.fn(async () =>
      makeRunSkillResult({
        verdictRaw: JSON.stringify({
          outcome: "landed",
          phase_reached: "pr",
          failure_category: null,
          detail: "Refined and ready for human review.",
        }),
      }),
    );
    const config = makeConfig();

    let result: LoopIterationResult | undefined;
    await expect(
      (async () => {
        result = await runLoopIteration(makeDeps({ jiraClient, config, runSkill }));
      })(),
    ).resolves.not.toThrow();

    expect(result!.action).toBe("processed");
    expect(result!.jiraSyncError).toMatch(/400 Bad Request/);
    const lines = await readRunLog(runsLogPath);
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("landed");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/loop-runner.test.ts`
Expected: FAIL — `jiraClient.swapLabel` is undefined in the mock's return
value used by `runLoopIteration` (which still calls `moveToEpic`), and/or
`makeMockJiraClient`'s object literal no longer satisfies the `JiraClient`
type once Task 3 lands (no `moveToEpic` on the interface).

- [ ] **Step 3: Implement** — in `src/loop-runner.ts`, replace the
  `outcome === "landed"` branch (currently lines 171-181):

```typescript
    if (outcome === "landed") {
      // Only an auto-promoted verdict swaps the label (straight to
      // handoffLabel, skipping human approval). A non-auto-promoted
      // landed verdict leaves the ticket at triggerLabel -- the ticket
      // just sits there, refined, until a human manually swaps the label.
      const autoPromote = ticket.labels.includes(config.autoPromoteLabel);
      if (autoPromote) {
        await jiraClient.swapLabel(
          ticket.key,
          config.jira.triggerLabel,
          config.jira.handoffLabel,
        );
      }
    } else if (outcome === "bounced") {
```

  Also update the doc comment on `LoopIterationResult.jiraSyncError`
  (currently referencing "the post-verdict Jira write
  (moveToEpic/transitionStatus)") to say `swapLabel/transitionStatus`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/loop-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full research-loop suite**

Run: `npm test`
Expected: all test files pass (this closes out research-loop's `src`/
`test` changes for Phase 0).

- [ ] **Step 6: Commit**

```bash
git add src/loop-runner.ts test/loop-runner.test.ts
git commit -m "feat(loop-runner): swap the autoPromoteLabel-gated epic move for a label swap"
```

---

## Task 5 (research-loop): config file + docs

**Files:**
- Modify: `pipeline.webtarsthree.config.json`
- Modify: `docs/config.md`
- Modify: `README.md`
- Modify: `.claude/skills/ticket-refine/SKILL.md`
- Modify: `docs/future-enhancements.md`
- Modify: `CHANGELOG.md`

No test file — these are config/doc changes verified by re-running the
full suite (which reads `pipeline.webtarsthree.config.json`'s *shape*
only through `Config`, not this specific file) and by manual review
against the spec's "Docs to update" list.

- [ ] **Step 1: Update `pipeline.webtarsthree.config.json`**

Current content (with the pre-existing uncommitted `ceilings` diff already
applied):

```json
{
  "jira": {
    "intakeEpics": ["TARS-1350"],
    "readyEpic": "TARS-1384",
    "claimStatus": { "from": "To Do", "to": "In Progress" },
    "pollJql": {
      "refine": "\"parent\" in ({epics}) AND status = \"To Do\" ORDER BY created ASC",
      "dev": "\"parent\" = {epic} AND status = \"To Do\" ORDER BY created ASC"
    },
    "epicLinkField": "parent",
    "statusNames": { "bounced": "Blocked", "prOpen": "Code Review" }
  },
  "ceilings": { "maxRunsPerDay": 100, "maxCostPerRunUsd": 50, "runTimeoutMin": 120 },
  "autoPromoteLabel": "auto-promote",
  "targetRepo": {
    "url": "git@github.com:fandango/webtarsthree.git",
    "defaultBranch": "master",
    "path": "/Users/206618626@bwt3.com/Desktop/Repos/webtarsthree"
  }
}
```

Replace with (note: `ceilings` values `50`/`120` are preserved exactly —
do not revert to `20`/`45`; the refine JQL per the spec drops the
`"parent" in (...)` clause for a `labels = ...` clause and keeps its
existing `status = "To Do"` clause):

```json
{
  "jira": {
    "triggerLabel": "pipeline:research",
    "handoffLabel": "pipeline:dev",
    "claimStatus": { "from": "To Do", "to": "In Progress" },
    "pollJql": {
      "refine": "labels = \"{label}\" AND status = \"To Do\" ORDER BY created ASC",
      "dev": "labels = \"{label}\" ORDER BY created ASC"
    },
    "statusNames": { "bounced": "Blocked", "prOpen": "Code Review" }
  },
  "ceilings": { "maxRunsPerDay": 100, "maxCostPerRunUsd": 50, "runTimeoutMin": 120 },
  "autoPromoteLabel": "auto-promote",
  "targetRepo": {
    "url": "git@github.com:fandango/webtarsthree.git",
    "defaultBranch": "master",
    "path": "/Users/206618626@bwt3.com/Desktop/Repos/webtarsthree"
  }
}
```

- [ ] **Step 2: Run the full suite to confirm the config file still loads correctly**

Run: `npm test`
Expected: all tests still pass (no test loads this exact file at runtime,
but this step catches a JSON syntax error immediately).

- [ ] **Step 3: Update `docs/config.md`**

In the "Shape" section, replace the `jira.intakeEpics` / `readyEpic` bullet
(lines 8-15) with:

```markdown
- `jira.triggerLabel` / `handoffLabel` — the two pipeline-stage labels a
  ticket moves through. `triggerLabel` (`"pipeline:research"`) is this
  loop's own poll target — fresh, unrefined tickets *and* already-refined
  tickets awaiting Justin's approval both carry it; there is no separate
  label for "awaiting approval" (that distinction is a comment on the
  ticket itself — presence of `Refined Spec — ready for ticket-to-pr` —
  not a label). `handoffLabel` (`"pipeline:dev"`) is dev-loop's poll
  target; this loop only ever *writes* it (on an auto-promoted verdict, by
  swapping it in for `triggerLabel`), never polls for it.
```

Delete the `jira.epicLinkField` bullet (lines 22-23) entirely — no
label-equivalent concept exists.

Replace the `jira.pollJql.{refine,dev}` bullet (lines 19-21):

```markdown
- `jira.pollJql.{refine,dev}` — JQL templates with a `{label}` placeholder,
  filled in by `src/jql.ts`. This repo only ever polls with `refine`.
```

In "Ticket status never reverts" (lines 54-68), replace the sentence
naming the **epic move**:

```markdown
Once this loop claims a ticket (`claimStatus.from` → `claimStatus.to`,
typically `To Do` → `In Progress`), status stays at `claimStatus.to` for the
rest of the pipeline's lifecycle — this loop never transitions it back
toward `claimStatus.from`, even on a passing verdict. The **label swap**
(`triggerLabel` → `handoffLabel`, on human approval or `autoPromoteLabel`)
is the real human-approval gate; status is not overloaded to also signal
that.
```

In "Appendix A (Jira wiring)" (lines 88-104), replace:

```markdown
Every Jira-specific value above starts as the literal placeholder string
`"___"` in a fresh `pipeline.<project>.config.json`. `findPlaceholders()` /
`assertNoPlaceholders()` in `src/config.ts` detect leftover placeholders —
`RealJiraClient` refuses to make a Jira call while any remain. Filling these
in for a real project means: confirming the two pipeline label strings
(this loop's `triggerLabel`, dev-loop's `handoffLabel`) and checking the
*child ticket* workflow for real status names.
```

and delete the entire "**Known tradeoff of the two-epic model**"
paragraph (lines 99-104) — no longer applicable, since the label swap
itself now distinguishes "still being refined" from "refined, awaiting
approval."

In "Adding a new project" (lines 106-114), replace step 2:

```markdown
2. Fill in that project's own label strings, statuses, JQL, and
   `targetRepo`.
```

- [ ] **Step 4: Update `README.md`**

Replace line 29:

```markdown
A passing verdict from this loop means the ticket is ready for the human
review gate — not ready for dev directly. Only after human review does a
ticket's label swap from `pipeline:research` to `pipeline:dev`, the label
dev-loop polls for.
```

- [ ] **Step 5: Update `.claude/skills/ticket-refine/SKILL.md`**

Replace the "Setup: idempotent re-refinement" section's re-pickup bullet
(lines 33-36):

```markdown
- **Re-pickup after human comments** (ticket status was reset to `To Do`
  with a steering comment added, still carrying `triggerLabel` —
  research-loop's intake and spec-review territory is one combined label
  state, not two, so there's no label to swap between at this point): read
  the human's comment(s) as steering input, and **revise** the existing
  refinement rather than starting over from scratch. Re-run only the steps
  the comment calls into question (e.g. if the human flagged an incorrect
  fault-domain call, redo Step 0's fault-domain determination and Step 6's
  synthesis; you don't need to redo Step 2's codebase grounding if it
  wasn't disputed).
```

Replace Step 7's outcome bullet (lines 327-331):

```markdown
- If it passes: write the `Refined Spec — ready for ticket-to-pr` comment
  (see ticket content protocol), set `verdict.outcome: "ready"`. The
  ticket stays at `triggerLabel`, refined and awaiting human approval (the
  loop runner only swaps the label to `handoffLabel` if `autoPromoteLabel`
  is present — this skill just reports the verdict either way).
```

- [ ] **Step 6: Update `docs/future-enhancements.md`**

In the "Jira label-based trigger..." entry's "**Phased rollout**" bullet
list, mark Phase 0's bullet as landed by rewriting its opening clause from
a plan ("**Phase 0 (Jira-only, both repos, no GitHub involved yet)**:
replace epic-parent polling with label polling...") to a past-tense,
done marker, keeping the rest of that bullet's content (the "without this,
dev-loop's trigger would never fire again" reasoning) intact as historical
rationale:

```markdown
- **Phase 0 (Jira-only, both repos, no GitHub involved yet) — DONE, see
  CHANGELOG.md.** Replaced epic-parent polling with label polling in both
  research-loop and dev-loop together — research-loop's `src/jql.ts`
  templates changed from `parent in ({epics})` to a `pipeline:research`
  label match; dev-loop's poll JQL changed from `parent = {epic} AND
  status = "In Progress"` to a `pipeline:dev` label match. Without this,
  once research-loop's approval step stopped moving the epic, dev-loop's
  existing trigger would never fire again — there's no "later" for
  dev-loop's trigger, so both repos moved together. The claim step was
  unchanged; the "approval" step (previously: move epic to `readyEpic`,
  gated by `autoPromoteLabel`) became the `pipeline:research`→
  `pipeline:dev` label swap, governed by the exact same manual-default/
  `autoPromoteLabel`-gated-automatic rule, and that swap is now the real
  handoff mechanism between the two repos. TDD'd in both repos; epics
  remain in Jira for board/PM use only, read by neither loop.
```

Leave Phase 1 and Phase 2's bullets, and every "Not yet scoped /
explicitly deferred" note, untouched — they still apply.

- [ ] **Step 7: Add a `CHANGELOG.md` entry**

Insert at the top (newest-first), above the existing `## 2026-09-02`
entry:

```markdown
## 2026-09-16 — Jira label-based trigger, Phase 0: epic-parent polling replaced with label polling

Per `docs/future-enhancements.md`'s "Jira label-based trigger" entry and
its Phase 0 design spec
(`docs/superpowers/specs/2026-09-15-jira-label-trigger-phase0-design.md`),
replaced the epic-parent trigger with a Jira label trigger, landed
together with the matching change in `dev-loop` (both repos must move
together — see the spec's "Why"). `Config.jira` drops
`intakeEpics`/`readyEpic`/`epicLinkField` in favor of two plain strings,
`triggerLabel` (`"pipeline:research"`) and `handoffLabel`
(`"pipeline:dev"`). `src/jql.ts`'s templates now substitute a single
`{label}` placeholder instead of `{epics}`/`{epic}`.
`JiraClient.moveToEpic` is replaced by `swapLabel(ticketKey, from, to)`,
implemented as one Jira `PUT` using the `update.labels` array-of-ops
shape — no GET-then-merge needed, since Jira's labels field supports this
directly. `loop-runner.ts`'s landed-verdict branch now calls `swapLabel`
in the exact same `autoPromoteLabel`-gated spot `moveToEpic` used to
occupy — unchanged manual-by-default behavior, just acting on a label
instead of an epic. Epics remain in Jira for board/PM visibility only,
untouched by any code from either repo.
```

- [ ] **Step 8: Run the full suite one more time**

Run: `npm test`
Expected: all test files pass.

- [ ] **Step 9: Commit**

```bash
git add pipeline.webtarsthree.config.json docs/config.md README.md \
  .claude/skills/ticket-refine/SKILL.md docs/future-enhancements.md CHANGELOG.md
git commit -m "docs+config: land research-loop's half of the Phase 0 label-trigger change"
```

---

## Task 6 (dev-loop): `Config.jira` shape — `triggerLabel`/`handoffLabel`

**Files:**
- Modify: `src/types.ts:120-158` (`JiraConfig`)
- Modify: `src/config.ts:69-88` (`PLACEHOLDER_PATHS`)
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `JiraConfig`/`Config["jira"]` now has `triggerLabel: string`
  and `handoffLabel: string` in place of `intakeEpics: string[]`,
  `readyEpic: string`, `epicLinkField: string`. `claimStatus`,
  `pollJql.{refine,dev}`, `statusNames`, `codeReviewFields` are unchanged.

- [ ] **Step 1: Write the failing test** — in
  `/Users/206618626@bwt3.com/Desktop/repos/dev-loop/test/config.test.ts`,
  update `makeConfig()` (lines 15-39):

```typescript
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "To Do", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" ORDER BY created ASC',
        dev: 'labels = "{label}" AND assignee = "{assignee}" ORDER BY created ASC',
      },
      statusNames: { bounced: "Blocked", prOpen: "Code Review" },
      codeReviewFields: {
        piiField: "customfield_13504",
        piiNoImpactOptionId: "14310",
        qaNotesField: "customfield_14226",
      },
      ...overrides.jira,
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 45 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:fandango/webtarsthree.git", defaultBranch: "master" },
    ...overrides,
  };
}
```

  Update the `loadConfig` test's assertion (currently
  `expect(config.jira.readyEpic).toBe("EPIC-READY")`, ~line 99) to:

```typescript
    expect(config.jira.handoffLabel).toBe("pipeline:dev");
```

  Update the "lists every field still set to the placeholder value" test
  (~lines 154-161):

```typescript
  it("lists every field still set to the placeholder value", () => {
    const config = makeConfig({
      jira: { ...makeConfig().jira, triggerLabel: "___", handoffLabel: "___" },
    });
    const missing = findPlaceholders(config);
    expect(missing).toContain("jira.triggerLabel");
    expect(missing).toContain("jira.handoffLabel");
  });
```

  (Leave the `codeReviewFields` placeholder test and the `targetRepoAddDir`
  tests untouched — unaffected by this change.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config.test.ts`
Expected: FAIL — the new `makeConfig()` shape doesn't type-check against
the still-unchanged `JiraConfig` interface, and `findPlaceholders` doesn't
recognize `jira.triggerLabel`/`jira.handoffLabel`.

- [ ] **Step 3: Update `src/types.ts`'s `JiraConfig`**

Replace lines 120-158's `JiraConfig` interface. Delete `intakeEpics`,
`readyEpic`, `epicLinkField` (and their doc comments) and add
`triggerLabel`/`handoffLabel`:

```typescript
export interface JiraConfig {
  /**
   * The label this repo's own poll matches on -- "pipeline:dev". Mutually
   * exclusive with triggerLabel-as-research-loop-sees-it: a ticket carries
   * exactly one pipeline-stage label at a time.
   */
  triggerLabel: string;
  /**
   * The label a passing research-loop verdict swaps a ticket to, handing
   * it off to this repo -- "pipeline:dev". Carried here for config-shape
   * symmetry with research-loop's own Config (mirroring how this repo's
   * Config already carries pollJql.refine today even though this repo's
   * runtime never polls with it), even though only research-loop's
   * loop-runner.ts performs the swap in Phase 0.
   */
  handoffLabel: string;
  claimStatus: ClaimStatusConfig;
  pollJql: PollJqlConfig;
  /**
   * Which existing Jira status names the loop runner's terminal outcomes
   * map onto -- this Jira instance has no literal "bounced" or "pr-open"
   * status, so these must be bound to whatever statuses actually exist in
   * the ticket's workflow (e.g. "Blocked" for bounced, "In Progress" for
   * pr-open).
   */
  statusNames: {
    bounced: string;
    prOpen: string;
  };
  /**
   * Jira custom field IDs written when transitioning a landed PR to Code
   * Review -- mirrors what the interactive `push-branch` skill sets by
   * hand today (its "Transition ticket to Code Review" step), so an
   * automated PR gets the same Code Review screen fields populated
   * instead of the transition silently failing to happen at all.
   */
  codeReviewFields: {
    /** "Covered Information Data Inventory" multicheckboxes field. */
    piiField: string;
    /** Option id for its "No Impact" value. */
    piiNoImpactOptionId: string;
    /** "QA Notes" textarea field. */
    qaNotesField: string;
  };
}
```

- [ ] **Step 4: Update `src/config.ts`'s `PLACEHOLDER_PATHS`**

Replace:

```typescript
  ["jira.readyEpic", (c) => c.jira.readyEpic],
```

and

```typescript
  ["jira.epicLinkField", (c) => c.jira.epicLinkField],
```

with:

```typescript
  ["jira.triggerLabel", (c) => c.jira.triggerLabel],
  ["jira.handoffLabel", (c) => c.jira.handoffLabel],
```

Keep every other entry (`claimStatus.from/to`, `pollJql.refine/dev`,
`statusNames.bounced/prOpen`, `codeReviewFields.*`, `autoPromoteLabel`,
`targetRepo.url/defaultBranch`) unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- test/config.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "feat(config): replace jira.intakeEpics/readyEpic/epicLinkField with triggerLabel/handoffLabel"
```

---

## Task 7 (dev-loop): `src/jql.ts` — `{label}` substitution, `{assignee}` kept

**Files:**
- Modify: `src/jql.ts` (both builders)
- Test: `test/jql.test.ts`

**Interfaces:**
- Consumes: `Config["jira"]["triggerLabel"]`/`["handoffLabel"]` (Task 6).
- Produces: `buildRefineJql(config: Config): string` — same signature.
  `buildDevJql(config: Config, assigneeAccountId: string): string` — same
  signature, second argument kept exactly as today.

- [ ] **Step 1: Write the failing test** — replace `test/jql.test.ts` in
  full:

```typescript
import { describe, expect, it } from "vitest";
import { buildDevJql, buildRefineJql } from "../src/jql.ts";
import type { Config } from "../src/types.ts";

const config: Config = {
  jira: {
    triggerLabel: "pipeline:research",
    handoffLabel: "pipeline:dev",
    claimStatus: { from: "Ready", to: "In Progress" },
    pollJql: {
      refine: 'labels = "{label}" AND status = "To Refine" ORDER BY created ASC',
      dev: 'labels = "{label}" AND assignee = "{assignee}" ORDER BY created ASC',
    },
    statusNames: { bounced: "Blocked", prOpen: "In Progress" },
    codeReviewFields: {
      piiField: "customfield_13504",
      piiNoImpactOptionId: "14310",
      qaNotesField: "customfield_14226",
    },
  },
  ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
  autoPromoteLabel: "auto-promote",
  targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
};

describe("buildRefineJql", () => {
  it("interpolates triggerLabel into the refine template", () => {
    const jql = buildRefineJql(config);
    expect(jql).toContain("pipeline:research");
    expect(jql).not.toContain("{label}");
  });

  it("returns a non-empty string", () => {
    const jql = buildRefineJql(config);
    expect(typeof jql).toBe("string");
    expect(jql.length).toBeGreaterThan(0);
  });
});

describe("buildDevJql", () => {
  it("interpolates handoffLabel and the assignee accountId into the dev template", () => {
    const jql = buildDevJql(config, "user-123");
    expect(jql).toContain("pipeline:dev");
    expect(jql).not.toContain("{label}");
    expect(jql).toContain("user-123");
    expect(jql).not.toContain("{assignee}");
  });

  it("no longer carries a status clause -- the label signals pipeline stage directly", () => {
    const jql = buildDevJql(config, "user-123");
    expect(jql).not.toContain("status");
  });

  it("returns a non-empty string", () => {
    const jql = buildDevJql(config, "user-123");
    expect(typeof jql).toBe("string");
    expect(jql.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/jql.test.ts`
Expected: FAIL — `buildRefineJql`/`buildDevJql` still read
`intakeEpics`/`readyEpic`, gone from `Config["jira"]` after Task 6 (type
error), and the templates use `{epics}`/`{readyEpic}`, not `{label}`.

- [ ] **Step 3: Implement** — replace `src/jql.ts` in full:

```typescript
// Builds resolved JQL strings from a Config's pollJql templates plus the
// jira.triggerLabel / jira.handoffLabel this repo's Config carries. Pure
// string-building - no Jira calls here.

import type { Config } from "./types.ts";

/**
 * Build the JQL used by the refine loop (Terminal A) to poll for tickets
 * carrying triggerLabel. Kept here (unused in this repo's own production
 * path) for the same test-symmetry reason research-loop keeps its own
 * unused-in-prod buildDevJql.
 */
export function buildRefineJql(config: Config): string {
  return config.jira.pollJql.refine.replace("{label}", config.jira.triggerLabel);
}

/**
 * Build the JQL used by the dev loop (Terminal B, this repo) to poll for
 * tickets carrying handoffLabel. `assigneeAccountId` fills the
 * `{assignee}` placeholder -- dev-loop only ever touches a ticket still
 * assigned to the configured human, since status no longer signals
 * "claimed" (see loop-runner.ts).
 */
export function buildDevJql(config: Config, assigneeAccountId: string): string {
  return config.jira.pollJql.dev
    .replace("{label}", config.jira.handoffLabel)
    .replace("{assignee}", assigneeAccountId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/jql.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jql.ts test/jql.test.ts
git commit -m "feat(jql): swap {epics}/{readyEpic} template placeholders for {label}, drop status clause from dev poll"
```

---

## Task 8 (dev-loop): `JiraClient.swapLabel` replaces `moveToEpic`

**Files:**
- Modify: `src/jira-client.ts` (interface, `StubJiraClient`, `RealJiraClient`; delete `JiraTicket.epic`)
- Test: `test/jira-client.test.ts`

**Interfaces:**
- Produces: `JiraClient.swapLabel(ticketKey: string, from: string, to: string): Promise<void>`,
  replacing `moveToEpic(ticketKey: string, epic: string): Promise<void>`.
  `JiraTicket` no longer has an `epic` field. `claimTicket`, `transitionStatus`,
  `assignTicket`, `addComment` are unchanged.

- [ ] **Step 1: Write the failing test** — in
  `/Users/206618626@bwt3.com/Desktop/repos/dev-loop/test/jira-client.test.ts`,
  update `makeConfig()` (lines 10-24):

```typescript
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
  };
}
```

  Note: this repo's existing `jira-client.test.ts` `makeConfig()` never
  included `statusNames`/`codeReviewFields` (only `loop-runner.test.ts`
  and `config.test.ts` do) — keep that same narrower shape, just swap
  the epic fields for label fields, same as today's pattern.

  In `pollOldestMatching`'s two response-body tests (~lines 80-115,
  117-140), drop the mocked `customfield_10014: "EPIC-1"` field from each
  response and drop `epic: "EPIC-1"` from the expected returned ticket —
  the first becomes:

```typescript
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
```

  and the second (`null assignee`) test drops its `customfield_10014`
  field from the mocked response, everything else unchanged.

  Delete the three `moveToEpic` tests (`"moveToEpic throws a clear error
  when epicLinkField is still the placeholder"` and the two PUT-shape
  tests, ~lines 242-280) and replace with:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/jira-client.test.ts`
Expected: FAIL — `swapLabel` doesn't exist on `RealJiraClient` yet.

- [ ] **Step 3: Implement** — in `src/jira-client.ts`:

  a. Delete `epic: string | null;` from `JiraTicket` (line 15).

  b. In the `JiraClient` interface, replace lines 50-54:

```typescript
  /**
   * Move a ticket to a different epic (e.g. from an intake epic to the
   * review epic, or from the review epic to the ready epic).
   */
  moveToEpic(ticketKey: string, epic: string): Promise<void>;
```

  with:

```typescript
  /**
   * Swap a ticket's pipeline-stage label from `from` to `to` in one PUT
   * (Jira's labels field supports a remove/add op pair directly -- no
   * GET-then-merge needed).
   */
  swapLabel(ticketKey: string, from: string, to: string): Promise<void>;
```

  c. In `StubJiraClient`, replace lines 110-112:

```typescript
  async moveToEpic(_ticketKey: string, _epic: string): Promise<void> {
    throw StubJiraClient.notConfigured("moveToEpic");
  }
```

  with:

```typescript
  async swapLabel(_ticketKey: string, _from: string, _to: string): Promise<void> {
    throw StubJiraClient.notConfigured("swapLabel");
  }
```

  d. Delete the `epicLinkField()` private method (lines 231-241).

  e. In `pollOldestMatching` (lines 243-268), delete the `epicField`/
  `epic` derivation and the `epicLinkField` entry in the `fields` array,
  and drop `epic` from the returned object:

```typescript
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
```

  f. Replace `moveToEpic` (lines 309-321) with:

```typescript
  async swapLabel(ticketKey: string, from: string, to: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${ticketKey}`, {
      method: "PUT",
      body: JSON.stringify({
        update: { labels: [{ remove: from }, { add: to }] },
      }),
    });
  }
```

  g. Update the class doc comment (lines 187-193) to drop the
  `epicLinkField`-selection sentence:

```typescript
/**
 * REST-backed JiraClient for Jira Cloud, authenticated via HTTP Basic auth
 * (email + API token) per Atlassian's documented auth scheme for the v3
 * REST API.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/jira-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/jira-client.ts test/jira-client.test.ts
git commit -m "feat(jira-client): replace moveToEpic with swapLabel; delete JiraTicket.epic"
```

---

## Task 9 (dev-loop): delete `decideEpicMove`; `LoopKind`/`"refine"` branch stay

**Files:**
- Modify: `src/loop-runner.ts` (delete `decideEpicMove` and its one call site)
- Test: `test/loop-runner.test.ts`

**Interfaces:**
- Consumes: `JiraClient.swapLabel` no longer called from this file at all
  (dev-loop's own runtime never called `moveToEpic` for `loopKind: "dev"`
  either — `decideEpicMove` always returned `null` there; deleting the
  function removes a dead-in-production code path, not a behavior change).
- Produces: `decideEpicMove` no longer exported. `LoopKind` (`"refine" |
  "dev"`), `runLoopIteration`'s signature, and the `loopKind === "refine"`
  branch (which only decides which JQL builder to call) are unchanged.

- [ ] **Step 1: Write the failing test** — in
  `/Users/206618626@bwt3.com/Desktop/repos/dev-loop/test/loop-runner.test.ts`:

  a. Update `makeConfig()` (lines 12-34) to the new `jira` shape:

```typescript
function makeConfig(): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      claimStatus: { from: "Ready", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" ORDER BY created ASC',
        dev: 'labels = "{label}" AND assignee = "{assignee}" ORDER BY created ASC',
      },
      statusNames: { bounced: "Blocked", prOpen: "In Progress" },
      codeReviewFields: {
        piiField: "customfield_13504",
        piiNoImpactOptionId: "14310",
        qaNotesField: "customfield_14226",
      },
    },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}
```

  b. Update `makeTicket()` (lines 37-45) to drop `epic`:

```typescript
function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return {
    key: "PROJ-1",
    status: "In Progress",
    assignee: ASSIGNEE_ACCOUNT_ID,
    ...overrides,
  };
}
```

  c. Update `makeMockJiraClient()` (lines 47-57) to mock `swapLabel`
  instead of `moveToEpic`:

```typescript
function makeMockJiraClient(overrides: Partial<JiraClient> = {}): JiraClient {
  return {
    pollOldestMatching: vi.fn(async () => null),
    claimTicket: vi.fn(async () => true),
    transitionStatus: vi.fn(async () => {}),
    swapLabel: vi.fn(async () => {}),
    assignTicket: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    ...overrides,
  };
}
```

  d. Delete every `jiraClient.moveToEpic` assertion and replace with the
  equivalent `swapLabel` assertion, in each of these five tests:
  - "malformed/missing verdict.json..." (~line 266):
    `expect(jiraClient.swapLabel).not.toHaveBeenCalled();`
  - "a post-run ceiling breach still records..." (~line 378):
    `expect(jiraClient.swapLabel).not.toHaveBeenCalled();`
  - "epic-move-on-verdict: a landed verdict from the dev loop never moves
    the epic..." (~line 477) — rename the test to drop "epic-move-on-
    verdict:" and rewrite its body's assertion:
    `expect(jiraClient.swapLabel).not.toHaveBeenCalled();`
  - "epic-move-on-verdict: a bounced verdict sets outcome bounced and does
    not move the epic" (~line 585) — rename similarly:
    `expect(jiraClient.swapLabel).not.toHaveBeenCalled();`
  - "a bounced verdict that already has a PR..." (~line 738):
    `expect(jiraClient.swapLabel).not.toHaveBeenCalled();`

  e. In the "never touches a real JiraClient implementation..." test
  (~lines 781-813), replace `moveToEpic` with `swapLabel` in the manually
  constructed `JiraClient` object:

```typescript
      const pollOldestMatching = vi.fn(async () => ticket);
      const claimTicket = vi.fn(async () => true);
      const transitionStatus = vi.fn(async () => {});
      const swapLabel = vi.fn(async () => {});
      const assignTicket = vi.fn(async () => {});
      const addComment = vi.fn(async () => {});
      const jiraClient: JiraClient = {
        pollOldestMatching,
        claimTicket,
        transitionStatus,
        swapLabel,
        assignTicket,
        addComment,
      };
```

  f. Delete the two test titles' "epic-move-on-verdict:" prefix noted in
  (d) above is already covered — no separate `decideEpicMove`-named unit
  tests exist in this file (`decideEpicMove` was only ever exercised
  indirectly through `runLoopIteration`), so no additional test deletions
  are needed beyond the assertion rewrites above.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/loop-runner.test.ts`
Expected: FAIL — `jiraClient.swapLabel` doesn't exist on the object
`runLoopIteration` receives (it still calls `moveToEpic` via
`decideEpicMove`), and the mock object literals no longer satisfy
`JiraClient` once Task 8 lands (no `moveToEpic` on the interface).

- [ ] **Step 3: Implement** — in `src/loop-runner.ts`:

  a. Delete the `decideEpicMove` function entirely (currently lines
  237-259, including its doc comment).

  b. Replace its call site (currently lines 158-162):

```typescript
    const epic = decideEpicMove(verdict, loopKind, config);
    if (epic) {
      await jiraClient.moveToEpic(ticket.key, epic);
    }
    if (loopKind === "dev" && verdict.outcome === "landed") {
```

  with:

```typescript
    if (loopKind === "dev" && verdict.outcome === "landed") {
```

  (No label/epic swap of any kind belongs here — epic-move is retired
  system-wide; `decideEpicMove`'s only live branch already always
  returned `null` for `loopKind: "dev"`, so this is a pure deletion, not
  a behavior change. `LoopKind` and the surrounding `if (loopKind ===
  "dev" && ...)` / bounce branches are otherwise untouched.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/loop-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full dev-loop suite**

Run: `npm test`
Expected: all test files pass.

- [ ] **Step 6: Commit**

```bash
git add src/loop-runner.ts test/loop-runner.test.ts
git commit -m "fix(loop-runner): delete decideEpicMove outright -- epic-move is retired system-wide; LoopKind/refine branch unchanged"
```

---

## Task 10 (dev-loop): config file + docs

**Files:**
- Modify: `pipeline.webtarsthree.config.json`
- Modify: `docs/config.md`
- Modify: `docs/skills.md`
- Modify: `.claude/skills/ticket-to-pr/SKILL.md` (additive to its existing uncommitted diff)
- Modify: `CHANGELOG.md` (additive to its existing uncommitted diff)

No test file — verified by re-running the full suite and manual review
against the spec's "Docs to update" list.

- [ ] **Step 1: Update `pipeline.webtarsthree.config.json`**

Current content:

```json
{
  "jira": {
    "intakeEpics": ["TARS-1350"],
    "readyEpic": "TARS-1384",
    "claimStatus": { "from": "To Do", "to": "In Progress" },
    "pollJql": {
      "refine": "\"parent\" in ({epics}) AND status = \"To Do\" ORDER BY created ASC",
      "dev": "\"parent\" = {readyEpic} AND status = \"In Progress\" AND assignee = \"{assignee}\" ORDER BY created ASC"
    },
    "epicLinkField": "parent",
    "statusNames": { "bounced": "Blocked", "prOpen": "Code Review" },
    "codeReviewFields": {
      "piiField": "customfield_13504",
      "piiNoImpactOptionId": "14310",
      "qaNotesField": "customfield_14226"
    }
  },
  "ceilings": { "maxRunsPerDay": 100, "maxCostPerRunUsd": 20, "runTimeoutMin": 45 },
  "autoPromoteLabel": "auto-promote",
  "targetRepo": {
    "url": "git@github.com:fandango/webtarsthree.git",
    "defaultBranch": "master",
    "path": "/Users/206618626@bwt3.com/Desktop/Repos/webtarsthree"
  }
}
```

Replace with (per the spec, the dev-poll JQL drops the `status =
"In Progress"` clause entirely — not kept as a belt-and-suspenders check;
`ceilings` here has no uncommitted diff to preserve, unlike
research-loop's copy of this file — leave `20`/`45` as-is):

```json
{
  "jira": {
    "triggerLabel": "pipeline:research",
    "handoffLabel": "pipeline:dev",
    "claimStatus": { "from": "To Do", "to": "In Progress" },
    "pollJql": {
      "refine": "labels = \"{label}\" AND status = \"To Do\" ORDER BY created ASC",
      "dev": "labels = \"{label}\" AND assignee = \"{assignee}\" ORDER BY created ASC"
    },
    "statusNames": { "bounced": "Blocked", "prOpen": "Code Review" },
    "codeReviewFields": {
      "piiField": "customfield_13504",
      "piiNoImpactOptionId": "14310",
      "qaNotesField": "customfield_14226"
    }
  },
  "ceilings": { "maxRunsPerDay": 100, "maxCostPerRunUsd": 20, "runTimeoutMin": 45 },
  "autoPromoteLabel": "auto-promote",
  "targetRepo": {
    "url": "git@github.com:fandango/webtarsthree.git",
    "defaultBranch": "master",
    "path": "/Users/206618626@bwt3.com/Desktop/Repos/webtarsthree"
  }
}
```

- [ ] **Step 2: Run the full suite to confirm the config file still loads correctly**

Run: `npm test`
Expected: all tests still pass.

- [ ] **Step 3: Update `docs/config.md`**

In "Shape" (lines 8-47), replace the `jira.intakeEpics` / `readyEpic`
bullet (lines 8-15):

```markdown
- `jira.triggerLabel` / `handoffLabel` — the two pipeline-stage labels a
  ticket moves through: `triggerLabel` (`"pipeline:dev"`) is this repo's
  own poll target — dev-loop's whole territory, end to end: picked up,
  coded, PR'd, code-reviewed, merged. `handoffLabel` (also
  `"pipeline:dev"`) is carried in this repo's Config for shape symmetry
  with research-loop's own Config, even though this repo's runtime never
  performs a label swap itself.
```

Delete the `jira.epicLinkField` bullet (lines 23-24) entirely.

Replace the `jira.pollJql.{refine,dev}` bullet (lines 21-22):

```markdown
- `jira.pollJql.{refine,dev}` — JQL templates with a `{label}` placeholder,
  filled in by `src/jql.ts`.
```

In "Ticket status never reverts" (lines 49-72), replace the sentence
naming the **epic move**:

```markdown
Once research-loop claims a ticket (`To Do` → `In Progress`), status stays
`In Progress` for the rest of the pipeline's lifecycle — no loop ever
transitions it back toward `To Do`. The **label swap**
(`triggerLabel` → `handoffLabel`, on human approval or `autoPromoteLabel`)
is the real human-approval gate; status is not overloaded to also signal
that.
```

and update the paragraph below it that explains why dev-loop's own poll
has no atomic claim step — replace "matches on `status = "In Progress"`
directly (not `"To Do"`) plus an `assignee = "{assignee}"` clause" with:

```markdown
Instead, `jira.pollJql.dev` matches on `labels = "pipeline:dev"` directly
plus an `assignee = "{assignee}"` clause (filled from
`JIRA_ASSIGNEE_ACCOUNT_ID`, see below) — no status clause at all, since the
label now signals pipeline stage directly and unambiguously — and
`runLoopIteration` for `loopKind: "dev"` has **no atomic claim step at
all**: it goes straight from poll to running the skill. This is safe only
because this MVP assumes exactly one dev-loop instance is ever running
against a project at a time.
```

Replace the "**A landed dev-loop verdict never moves the epic**" section
heading and body (lines 92-117) — **keep the heading and the TARS-1349
incident narrative exactly**, updating only the epic-specific vocabulary:

```markdown
## A landed dev-loop verdict never moves the epic

TARS-1349's real Jira run (the first end-to-end dev-loop pass) landed a PR
but never actually moved the ticket to Code Review — `moveToEpic` ran, but
nothing ever called `transitionStatus` for a landed outcome, so the
transition itself was simply missing from the code, not rejected by Jira.
That was fixed the same night — but the first fix also moved the ticket's
**epic** on a landed verdict, which turned out to be its own bug: at the
time, research-loop's spec-review epic ("Pipeline: Review") already meant
"refined spec is awaiting human approval," and landing a dev-loop PR there
too overloaded that same epic to mean two different things depending on
which ticket you were looking at — confirmed confusing on the real board
(landed PRs and spec-review tickets both showed the same epic name, with
no way to tell them apart without opening each one). That epic no longer
exists at all now (epics were retired system-wide in favor of a Jira label
trigger — see `CHANGELOG.md`) — but the underlying fix stands regardless
of naming.

Fixed by removing the epic move entirely for a landed dev-loop verdict —
`decideEpicMove` used to return `null` whenever `loopKind === "dev"`,
regardless of outcome; that function (and the epic-move call site
entirely) has since been deleted outright, since no loop moves anything
epic-or-label-shaped on a landed dev-loop verdict at all. A landed ticket
stays at whatever label it already carries (`handoffLabel`,
`"pipeline:dev"`); **status alone** — `In Progress` → `Code Review` — is
the "needs code review" signal now. research-loop's own landed/ready
verdicts still swap the label normally (`triggerLabel` → `handoffLabel`,
on `autoPromoteLabel` — the real human-approval gate, unrelated to this
fix; a non-auto-promoted verdict leaves the ticket in place, carrying
`triggerLabel`).
```

In "Appendix A (Jira wiring)" (lines 149-166), replace:

```markdown
Every Jira-specific value above starts as the literal placeholder string
`"___"` in a fresh `pipeline.<project>.config.json`. `findPlaceholders()` /
`assertNoPlaceholders()` in `src/config.ts` detect leftover placeholders —
`RealJiraClient` refuses to make a Jira call while any remain. Filling these
in for a real project means: confirming the two pipeline label strings
(`triggerLabel`, `handoffLabel`) and checking the *child ticket* workflow
for real status names.
```

and delete the entire "**Known tradeoff of the two-epic model**"
paragraph (lines 160-166) — no longer applicable.

In "Adding a new project" (lines 168-175), replace step 2:

```markdown
2. Fill in that project's own label strings, statuses, JQL, and
   `targetRepo`.
```

- [ ] **Step 4: Update `docs/skills.md`**

Replace line 98's sentence:

```markdown
Every skill run writes `RUN_DIR/verdict.json` (schema in the SKILL.md file
itself). The loop runner (`src/loop-runner.ts`) reads it via
`parseVerdict()` in `src/verdict.ts` — a missing or malformed file becomes
`outcome: "error"`, `failure_category: "agent_error"`, never a crash. The
loop runner derives the real `RunLogLine` (adding ticket/skill/timing
metadata the skill doesn't need to self-report) from this verdict — it no
longer derives any epic-or-label-move decision from the verdict at all
(`decideEpicMove` was deleted; no loop moves anything epic-or-label-shaped
on a landed dev-loop verdict).
```

- [ ] **Step 5: Update `.claude/skills/ticket-to-pr/SKILL.md`**

This file already has an uncommitted, unrelated diff (`COMMIT_TYPE`
derivation, per the pre-existing `git diff` on this repo) — this step is
additive on top of that existing diff, not a revert of it. Locate line
164 (the current numbering, which may have shifted slightly if the
pre-existing diff's own edits landed above it — search for the literal
string `"reached the Ready epic"` rather than trusting the line number)
and replace:

```markdown
2. Find the comment titled exactly `Refined Spec — ready for ticket-to-pr`.
   If no such comment exists, or it exists but doesn't follow the
   definition-of-ready template from `ticket-refine` (`### Overview`,
   `### Acceptance Criteria`, `### Scope`) — this ticket should never have
   carried the `pipeline:dev` label — bounce immediately with
   `failure_category: "spec_ambiguous"` and detail noting the missing
   comment/sections. Do not attempt to proceed on an unreadied ticket.
```

- [ ] **Step 6: Add a `CHANGELOG.md` entry**

This file also already has an uncommitted, unrelated diff (the
`COMMIT_TYPE`/conventional-commit entry) — insert the new entry above
that existing top entry, keeping it intact:

```markdown
## 2026-09-16 — Jira label-based trigger, Phase 0: epic-parent polling replaced with label polling

Per research-loop's `docs/future-enhancements.md` "Jira label-based
trigger" entry and its Phase 0 design spec (see research-loop's
`docs/superpowers/specs/2026-09-15-jira-label-trigger-phase0-design.md`),
replaced the epic-parent trigger with a Jira label trigger, landed
together with the matching change in `research-loop` (both repos must
move together — see the spec's "Why"; without this, research-loop's
approval step no longer moves an epic, and this repo's old trigger would
never fire again). `Config.jira` drops `intakeEpics`/`readyEpic`/
`epicLinkField` in favor of two plain strings, `triggerLabel`
(`"pipeline:dev"`) and `handoffLabel` (also `"pipeline:dev"`, carried for
shape symmetry only). `src/jql.ts`'s dev-poll template now substitutes
`{label}` in place of `{readyEpic}`, keeps its existing `{assignee}`
placeholder and second function argument unchanged, and drops the
`status = "In Progress"` clause entirely — the label now signals pipeline
stage directly, so keeping status alongside it would reintroduce the same
state redundancy the label swap removes. `JiraClient.moveToEpic` is
replaced by `swapLabel(ticketKey, from, to)`. `decideEpicMove` and its
`readyEpic`-returning branch are deleted outright (not stubbed) — this
repo's `loopKind: "dev"` path never called `moveToEpic` in production
anyway, so this removes a dead-in-production code path, not a behavior
change; `LoopKind` and the `loopKind === "refine"` branch (which only
decides which JQL builder to call) are unchanged. Epics remain in Jira for
board/PM visibility only, untouched by any code from either repo.
```

- [ ] **Step 7: Run the full suite one more time**

Run: `npm test`
Expected: all test files pass.

- [ ] **Step 8: Commit**

```bash
git add pipeline.webtarsthree.config.json docs/config.md docs/skills.md \
  .claude/skills/ticket-to-pr/SKILL.md CHANGELOG.md
git commit -m "docs+config: land dev-loop's half of the Phase 0 label-trigger change"
```

---

## Task 11 (both repos): final cross-repo verification

**Files:** none modified — verification only.

- [ ] **Step 1: Full test suite, research-loop**

Run (from `/Users/206618626@bwt3.com/Desktop/Repos/research-loop`):
`npm test`
Expected: all test files pass, 0 failures.

- [ ] **Step 2: Full test suite, dev-loop**

Run (from `/Users/206618626@bwt3.com/Desktop/repos/dev-loop`):
`npm test`
Expected: all test files pass, 0 failures.

- [ ] **Step 3: Confirm no stale epic references remain in either repo's `src`/`test`/tracked docs**

Run:
```bash
grep -rln "intakeEpics\|readyEpic\|epicLinkField\|moveToEpic\|decideEpicMove" \
  /Users/206618626@bwt3.com/Desktop/Repos/research-loop/src \
  /Users/206618626@bwt3.com/Desktop/Repos/research-loop/test \
  "/Users/206618626@bwt3.com/Desktop/repos/dev-loop/src" \
  "/Users/206618626@bwt3.com/Desktop/repos/dev-loop/test"
```
Expected: no output (empty match list). If anything prints, it's a missed
call site or test assertion from an earlier task — go fix it there rather
than patching it in this verification task.

- [ ] **Step 4: Confirm both `pipeline.webtarsthree.config.json` files parse and match the new shape**

Run:
```bash
node -e 'console.log(JSON.parse(require("fs").readFileSync("/Users/206618626@bwt3.com/Desktop/Repos/research-loop/pipeline.webtarsthree.config.json")).jira)'
node -e 'console.log(JSON.parse(require("fs").readFileSync("/Users/206618626@bwt3.com/Desktop/repos/dev-loop/pipeline.webtarsthree.config.json")).jira)'
```
Expected: both print an object with `triggerLabel: 'pipeline:research'`
(research-loop) / `'pipeline:dev'` (dev-loop) and `handoffLabel:
'pipeline:dev'` — no `intakeEpics`/`readyEpic`/`epicLinkField` keys.

- [ ] **Step 5: Confirm research-loop's preserved ceilings values**

Run:
```bash
node -e 'console.log(JSON.parse(require("fs").readFileSync("/Users/206618626@bwt3.com/Desktop/Repos/research-loop/pipeline.webtarsthree.config.json")).ceilings)'
```
Expected: `{ maxRunsPerDay: 100, maxCostPerRunUsd: 50, runTimeoutMin: 120 }`
— confirms the pre-existing uncommitted diff's values (`50`, `120`) were
not accidentally reverted during Task 5's edit.

No commit for this task — it's pure verification. If any step fails, fix
the root cause in the task that introduced the gap, not here.
