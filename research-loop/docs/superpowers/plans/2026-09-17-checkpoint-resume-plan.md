# Checkpoint Resume: dev-loop bounce-loop fix, GitHubClient, merge-reconciliation, comment templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume from the 2026-09-16-evening checkpoint and close out four
items from `research-loop/docs/future-enhancements.md`: (1) fix dev-loop's
live bounce-loop bug, (2) give dev-loop its first `GitHubClient`, (3) add
dev-loop's startup-time merge-reconciliation pass, (4) simplify the
Jira/GitHub comment templates in both repos.

**Architecture:** Two repos, `research-loop` (Terminal A) and `dev-loop`
(Terminal B, at `/Users/206618626@bwt3.com/Desktop/repos/dev-loop`), each
with their own `src/`, `npm test`, and TDD discipline. Item 1 is a one-line
JQL change in dev-loop plus a documentation note in research-loop (the
decision itself lives in `future-enhancements.md`). Item 2 ports
research-loop's already-shipped `src/github-client.ts` pattern into
dev-loop almost verbatim, adding `addComment`/`closeIssue`. Item 3 adds a
new pure `src/reconcile.ts` module to dev-loop (mirroring the
`src/poll-loop.ts`/`src/ceilings.ts` "pulled-out, unit-tested, untested
composition root calls it" pattern already used throughout both repos),
wired into `main.ts`'s poll loop right before each `runLoopIteration`
call. Item 4 rewrites the comment-title/body-building functions in both
repos (`buildBounceCommentAdf` in dev-loop's `loop-runner.ts`;
`ticket-refine/SKILL.md`'s "Ticket content protocol" in research-loop) and
updates the matching re-pickup detection logic that greps for the old
fixed titles.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`, no build
step), Vitest, `gh` CLI (already authenticated: `gh auth status` confirms
`JustinChan-fd`), Atlassian MCP tools, bash hooks, `jq`.

**Spec:** `research-loop/docs/future-enhancements.md` — read the four
sections named below before starting the matching task. This plan does
not re-derive their reasoning; it only makes the two decisions the doc
left open (below) and turns the rest into TDD'd tasks.

## Decisions made for this plan (previously open in the spec)

- **Item 1 (bounce-loop bug):** fixed via a **JQL status-exclusion
  clause** on `pollJql.dev` (`AND status != "{bouncedStatus}"`), not
  `swapLabel()`. Reuses `config.jira.statusNames.bounced` — no new config
  field. `pipeline:dev` remains untouched on a bounce, matching every
  other project's current label semantics.
- **Item 3 (merge-reconciliation pass):** dev-loop's `stageLabels`/
  `pipeline:pr-open` label design was abandoned (per
  `future-enhancements.md`'s checkpoint section) — there is no label
  marking "has an open PR" today. The reconciliation pass instead finds
  candidates via **JQL** (`handoffLabel` + `status = statusNames.prOpen`,
  i.e. tickets already sitting in "Code Review"), gets each ticket's PR
  URL from the **most recent `"landed"` line in `runs/<slug>.jsonl`** for
  that ticket key (the PR URL is already written there —
  `RunLogLine.pr` — no new field needed), and checks
  `gh pr view <url> --json state,mergedAt`. On a confirmed merge:
  **close the GitHub Issue only** (`state_reason: "completed"`). The Jira
  ticket's status/label is left exactly as-is — no new
  `statusNames.merged` config field, no Jira transition. A human closes
  the Jira ticket by hand; this pass only stops the GitHub Issue from
  going stale. This is deliberately narrower than the original design
  doc's full `pipeline:dev`→`pipeline:merged` swap, which depended on the
  abandoned label design.
- **Execution mode:** fully autonomous across all four items — TDD each
  task, `npm test` green before/after every `src/` change (both repos),
  commit per task, report back after each of the 4 items or sooner only
  on a genuine blocker (ambiguous requirement, a test that won't go
  green, a design gap the spec doesn't resolve).

## Global Constraints

- **TDD, strictly, for every `src/` change in both repos** — per each
  repo's own `CLAUDE.md`. `npm test` must be green before and after every
  task.
- **Read `docs/skills.md` before editing `.claude/skills/*/SKILL.md` or
  `.claude/agents/*`** — per both repos' `CLAUDE.md`. Already done for
  this plan (Task 8/9 touch `SKILL.md` files).
- **Read `docs/config.md` before touching `src/config.ts`, `Config` in
  `src/types.ts`, or any `pipeline.*.config.json`** — per both repos'
  `CLAUDE.md`. Already done (Task 1, Task 4).
- **Never write a raw secret/credential value anywhere.** Reuse
  `src/redact.ts`'s `containsSecret()`/`redactSecrets()` in both repos —
  never reimplement.
- **Closed `FailureCategory` enum is unchanged** in both repos — no task
  below adds or removes a value.
- **Do not touch the two `catalog-ui-*` config files' remaining
  unfilled placeholders** unless doing so via a live Jira lookup — matches
  the standing instruction from the prior session. Task 1's JQL template
  change touches the *shape* of `pollJql.dev` in all three dev-loop
  project config files (mechanical, not a placeholder resolution); it
  does not fill in any `"___"` value.
- **research-loop's own Phase 0/Phase 1 work (GitHub mirror, routing
  rule, secret hook, `repoLabel`, `mentionAccountId`) is already shipped
  and out of scope for this plan** — this plan only touches dev-loop's
  missing half (items 2-3) and both repos' comment templates (item 4).

---

## Task 1: Fix the bounce-loop bug — status-exclusion clause on `pollJql.dev`

**Files (dev-loop):**
- Modify: `src/jql.ts` (`buildDevJql` interpolates a new `{bouncedStatus}`
  placeholder)
- Modify: `test/jql.test.ts`
- Modify: `pipeline.webtarsthree.config.json`,
  `pipeline.catalog-ui-management.config.json`,
  `pipeline.catalog-ui-public.config.json` (`pollJql.dev` template gains
  the exclusion clause)
- Modify: `docs/config.md` (document the fix, replacing the "no status
  clause at all" framing in "Ticket status never reverts")
- Modify: `CHANGELOG.md` (new entry)

**Interfaces:**
- Consumes: `config.jira.statusNames.bounced` (already exists in
  `Config`, no type change).
- Produces: `buildDevJql(config, assigneeAccountId)` (unchanged
  signature) now also substitutes `{bouncedStatus}` if the template
  contains it. No later task in this plan depends on this — item 1 is
  fully self-contained.

Per the decided tradeoff above: add `AND status != "{bouncedStatus}"` to
every project's `pollJql.dev` template, and have `buildDevJql` fill it
from `config.jira.statusNames.bounced`. This is the smaller-blast-radius
option named in `future-enhancements.md`'s "Real tradeoff, not yet
decided" section — accepting that JQL correctness now depends on
`statusNames.bounced` being accurate per project (already true: every
project's `statusNames.bounced` is already required, non-placeholder,
config today).

- [ ] **Step 1: Write the failing test for `{bouncedStatus}` interpolation**

In `test/jql.test.ts`, add a `bouncedStatus` field reference to the
existing `config` object's `statusNames` (no change needed — it already
has `bounced: "Blocked"`), and add these two tests inside the
`describe("buildDevJql", ...)` block, right after the existing "no longer
carries a status clause" test (which must be **replaced**, not kept
alongside — see Step 1b):

```typescript
  it("excludes tickets already in the bounced status, so a bounced ticket does not immediately re-match its own poll", () => {
    const jql = buildDevJql(config, "user-123");
    expect(jql).toContain('status != "Blocked"');
    expect(jql).not.toContain("{bouncedStatus}");
  });
```

**Step 1b:** Delete the now-stale test right above it,
`"no longer carries a status clause -- the label signals pipeline stage
directly"` — it asserted `expect(jql).not.toContain("status")`, which
this fix deliberately reverses. Its own name explains exactly why it must
go: the label alone was proven (by the live TARS-1462 incident) to be
insufficient, so a status clause is coming back, narrowly, for bounced
tickets specifically. Leaving both tests in place would make the suite
self-contradictory.

Also update the `config` object's `pollJql.dev` template at the top of
`test/jql.test.ts` to include the new clause, so the fixture matches what
Step 3 will make `buildDevJql` expect:

```typescript
    dev: 'labels = "{label}" AND labels = "{repoLabel}" AND assignee = "{assignee}" AND status != "{bouncedStatus}" ORDER BY created ASC',
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- jql`
Expected: FAIL — `buildDevJql` doesn't substitute `{bouncedStatus}` yet,
so the raw placeholder leaks through and `jql` doesn't contain
`'status != "Blocked"'`.

- [ ] **Step 3: Update `buildDevJql` in `src/jql.ts`**

Replace the function body:

```typescript
export function buildDevJql(config: Config, assigneeAccountId: string): string {
  return config.jira.pollJql.dev
    .replace("{label}", config.jira.handoffLabel)
    .replace("{repoLabel}", config.jira.repoLabel)
    .replace("{assignee}", assigneeAccountId)
    .replace("{bouncedStatus}", config.jira.statusNames.bounced);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- jql`
Expected: PASS.

- [ ] **Step 5: Run the full suite to verify nothing else broke**

Run: `npm test`
Expected: PASS, all green. (No other test file builds a raw `pollJql.dev`
string containing `{bouncedStatus}` today, so no other file needs
updating — confirm this by grepping `grep -rn "pollJql" test/` and
checking each hit's template string already matches or doesn't care.)

- [ ] **Step 6: Update the three project config files' `pollJql.dev` template**

In `pipeline.webtarsthree.config.json`, change:
```json
      "dev": "labels = \"{label}\" AND labels = \"{repoLabel}\" AND assignee = \"{assignee}\" AND status != \"{bouncedStatus}\" ORDER BY created ASC"
```

In `pipeline.catalog-ui-management.config.json` and
`pipeline.catalog-ui-public.config.json`, same change (their existing
`dev` template already has the `{repoLabel}`/`{assignee}` clauses — just
append ` AND status != "{bouncedStatus}"` before ` ORDER BY`).

- [ ] **Step 7: Manually verify the fix against the real, currently-stuck TARS-1462**

TARS-1462 is live right now at status `Blocked`, carrying both
`pipeline:dev` and `pipeline:research` labels (confirmed via
`getJiraIssue` during planning). Run this by hand (read-only, no write):

```bash
node --env-file=.env -e '
import { loadConfig } from "./src/config.ts";
import { buildDevJql } from "./src/jql.ts";
const config = await loadConfig("pipeline.webtarsthree.config.json");
console.log(buildDevJql(config, process.env.JIRA_ASSIGNEE_ACCOUNT_ID));
'
```

Expected output contains `status != "Blocked"`. Then confirm by hand (via
the Atlassian MCP `searchJiraIssuesUsingJql` tool, not `gh`) that this
exact JQL string no longer matches TARS-1462 (its status is currently
`Blocked`) but would have matched before this fix. This is the concrete
evidence the fix actually closes the live incident, not just that the
unit test passes.

- [ ] **Step 8: Update `docs/config.md`**

In the "## Ticket status never reverts" section, the paragraph starting
"Instead, `jira.pollJql.dev` matches on `labels = \"pipeline:dev\"`
directly plus an `assignee = \"{assignee}\"` clause... no status clause
at all" is now inaccurate. Replace it with:

```markdown
Instead, `jira.pollJql.dev` matches on `labels = "pipeline:dev"` directly
plus an `assignee = "{assignee}"` clause (filled from
`JIRA_ASSIGNEE_ACCOUNT_ID`, see below), plus (as of the bounce-loop fix
below) `AND status != "{bouncedStatus}"` (filled from
`jira.statusNames.bounced`) — the label signals pipeline stage, but a
genuine bounce needs its own exclusion so the very next poll cycle
doesn't immediately re-match and re-run the same ticket. `runLoopIteration`
for `loopKind: "dev"` still has **no atomic claim step at all**: it goes
straight from poll to running the skill. This is safe only because this
MVP assumes exactly one dev-loop instance is ever running against a
project at a time.

**Bounce-loop bug, fixed:** before this exclusion clause existed, a
bounced ticket (status transitioned to `statusNames.bounced`, e.g.
"Blocked") kept matching `pollJql.dev` every single poll cycle
(`postRunDelaySec` = 5s) since nothing about the JQL's own match criteria
ever changed on a bounce — only the label-based design (`triggerLabel`/
`handoffLabel`) changed anything, and a bounce never touches the label.
Confirmed live on TARS-1462: 5 near-identical bounces in ~14 minutes,
~$2.3 total cost, until the process was killed by hand. See
`CHANGELOG.md`'s entry for this fix and research-loop's
`docs/future-enhancements.md`'s "dev-loop bounce-loop bug" entry for the
full incident writeup and the tradeoff this fix resolves.
```

- [ ] **Step 9: Add a `CHANGELOG.md` entry**

Add at the top (after the header, before the newest existing entry):

```markdown
## 2026-09-17 — fix bounce-loop bug: exclude bounced-status tickets from pollJql.dev

A bounced dev-loop ticket (status transitioned to `statusNames.bounced`,
e.g. "Blocked") kept matching `pollJql.dev` on every subsequent poll cycle
— nothing in the JQL's match criteria changed on a bounce, since
`pipeline:dev`'s label-based design was never meant to also encode
bounced-vs-not. Confirmed live on TARS-1462: 5 near-identical bounces in
~14 minutes (~$2.3) before the process was killed by hand; left unfixed,
every future dev-loop bounce would repeat this until `maxRunsPerDay`
trips (a ~$46 ceiling at this ticket's observed cost-per-run) or a human
intervenes. Fixed by adding `AND status != "{bouncedStatus}"` to every
project's `pollJql.dev` template, filled from the already-configured
`jira.statusNames.bounced` — no new config field, no label change. See
research-loop's `docs/future-enhancements.md`'s "dev-loop bounce-loop
bug" entry for the full tradeoff analysis this resolves (chose JQL
status-exclusion over `swapLabel()`-on-bounce, since the label-strip
alternative left "what does the label become instead" unscoped).
```

- [ ] **Step 10: Commit**

```bash
git add src/jql.ts test/jql.test.ts pipeline.webtarsthree.config.json pipeline.catalog-ui-management.config.json pipeline.catalog-ui-public.config.json docs/config.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
fix(jql): exclude bounced-status tickets from pollJql.dev, fixing the live bounce-loop bug

A bounced ticket's status transitions to statusNames.bounced (e.g.
"Blocked"), but pollJql.dev never checked status at all -- only the
pipeline:dev label, which a bounce never touches. This meant a bounced
ticket re-matched and re-ran on every single poll cycle (postRunDelaySec
= 5s) until maxRunsPerDay tripped or a human killed the process.
Confirmed live on TARS-1462: 5 near-identical bounces in ~14 minutes,
~$2.3 total cost.

Fixed via the smaller-blast-radius option named in research-loop's
docs/future-enhancements.md: add "AND status != {bouncedStatus}" to
pollJql.dev, filled from the already-configured jira.statusNames.bounced.
No new config field, no label change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: research-loop side-note — cross-link the fix in `future-enhancements.md`

**Files (research-loop):**
- Modify: `docs/future-enhancements.md`

**Interfaces:** none — documentation only.

The "dev-loop bounce-loop bug" entry in research-loop's own
`future-enhancements.md` currently reads "Confirmed live bug, not yet
fixed." Once Task 1 lands in dev-loop, this entry is stale in the one
research-loop doc that's supposed to be the shared holding pen. Since
research-loop's `CLAUDE.md` says entries move to `CHANGELOG.md` once
implemented and get deleted from this doc — but this specific entry was
*dev-loop's* fix (landed in dev-loop's own `CHANGELOG.md`, Task 1 Step
9) — the cleanest resolution is: delete the "dev-loop bounce-loop bug"
section entirely from research-loop's `future-enhancements.md` (it's
fully resolved, and its resolution is recorded in dev-loop's own
CHANGELOG, which is the correct home for a dev-loop behavior change per
research-loop's own CLAUDE.md's "not tickets it processes" framing), and
add one line to the "What's actually left, in priority order" list at
the very bottom of the doc's big "Jira label-based trigger" section
noting it's done.

- [ ] **Step 1: Remove the resolved section**

Delete the entire `## dev-loop bounce-loop bug: a bounced ticket
re-triggers itself indefinitely` section (from its `##` heading through
the line right before the next `##` heading, `## Jira label-based
trigger...`).

- [ ] **Step 2: Update the "What's actually left" list**

At the very end of the "Jira label-based trigger" section's "**What's
actually left, in priority order for closing this entry out**" list,
change item 1's framing doesn't need touching (it's about
`addComment`/`closeIssue`, unrelated), but add a note directly under the
list (after item 6) :

```markdown
**Aside, resolved 2026-09-17 (tracked in dev-loop's own CHANGELOG.md, not
here — this doc's rule is "not tickets it processes," and this was a
dev-loop pipeline-behavior fix)**: the dev-loop bounce-loop bug (a
bounced ticket re-polling and re-bouncing itself every ~5s) is fixed —
`pollJql.dev` now excludes tickets already at `statusNames.bounced`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/future-enhancements.md
git commit -m "$(cat <<'EOF'
docs: remove resolved dev-loop bounce-loop bug entry from future-enhancements

Fixed in dev-loop (see that repo's CHANGELOG.md, 2026-09-17) -- pollJql.dev
now excludes bounced-status tickets. Per this doc's own rule ("not tickets
it processes"), a dev-loop pipeline-behavior fix's record lives in
dev-loop's own CHANGELOG, not duplicated here; left a one-line pointer in
the still-open "Jira label-based trigger" entry instead.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: dev-loop's `GitHubClient` interface + `RealGitHubClient`

**Files (dev-loop):**
- Create: `src/github-client.ts`
- Test: `test/github-client.test.ts`

**Interfaces:**
- Consumes: nothing new — this is dev-loop's first GitHub-facing module.
- Produces: `GitHubIssue { number: number; url: string }`;
  `GitHubClient` interface with `addComment(issueNumber: number, body:
  string): Promise<void>` and `closeIssue(issueNumber: number, reason:
  "completed" | "not_planned" | "duplicate"): Promise<void>`;
  `StubGitHubClient` (throws on every method, mirrors research-loop's own
  `StubGitHubClient` and dev-loop's existing `StubJiraClient` pattern);
  `RealGitHubClient` (constructor takes `{ repo: string }` and an
  injected `ExecGhFn`, shells out to `gh`); `realExecGh(): ExecGhFn`.
  Task 5 (dev-loop's `loop-runner.ts` wiring) and Task 6 (the
  reconciliation pass) both depend on this exact shape.

This is a near-verbatim port of research-loop's already-shipped
`src/github-client.ts` — same interface style (mirrors `JiraClient`'s
narrow, purpose-built methods; shells out to `gh` since that's already
this pipeline family's established GitHub-auth pattern), same
`ExecGhFn`-injection-for-testability pattern, same `UNCONFIGURED_MESSAGE`
stub-throw convention. The two methods dev-loop actually needs
(`addComment`, `closeIssue`) are different from research-loop's
(`findIssueByJiraKey`, `createIssue`) because dev-loop never creates the
mirror Issue — research-loop already did, before handing the ticket off
— dev-loop only ever writes to and closes an Issue that's guaranteed to
already exist by the time a ticket carries `pipeline:dev`.

**Design note on `findIssueByJiraKey`:** dev-loop's own `addComment`/
`closeIssue` calls need a GitHub issue *number*, not a Jira key — and
unlike research-loop, dev-loop has no config field pointing it at "the"
mirror Issue for a ticket (research-loop's `createIssue` return value is
never persisted anywhere dev-loop can read). So `GitHubClient` here
**also** needs `findIssueByJiraKey(jiraKey: string): Promise<GitHubIssue
| null>` — same method, same title-prefix-search implementation as
research-loop's — so dev-loop's own call sites (Task 5, Task 6) can go
from a Jira key to an issue number without any new config or Jira field.
Port this method too, verbatim.

- [ ] **Step 1: Write the failing test for the full interface shape**

Create `test/github-client.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { RealGitHubClient, StubGitHubClient } from "../src/github-client.ts";

describe("StubGitHubClient", () => {
  it("throws on every method until wired with a real config", async () => {
    const client = new StubGitHubClient();
    await expect(client.findIssueByJiraKey("PROJ-1")).rejects.toThrow(/not configured/);
    await expect(client.addComment(42, "hello")).rejects.toThrow(/not configured/);
    await expect(client.closeIssue(42, "completed")).rejects.toThrow(/not configured/);
  });
});

describe("RealGitHubClient", () => {
  it("findIssueByJiraKey searches by title prefix and returns the first match", async () => {
    const execFn = vi.fn(async () =>
      JSON.stringify([{ number: 42, url: "https://github.com/org/repo/issues/42" }]),
    );
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.findIssueByJiraKey("PROJ-1");

    expect(issue).toEqual({ number: 42, url: "https://github.com/org/repo/issues/42" });
    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "list",
      "--repo",
      "org/repo",
      "--search",
      'in:title "PROJ-1:"',
      "--state",
      "all",
      "--json",
      "number,url",
    ]);
  });

  it("findIssueByJiraKey returns null when no issue matches", async () => {
    const execFn = vi.fn(async () => JSON.stringify([]));
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.findIssueByJiraKey("PROJ-1");

    expect(issue).toBeNull();
  });

  it("addComment posts to the given issue number via gh issue comment", async () => {
    const execFn = vi.fn(async () => "https://github.com/org/repo/issues/42#issuecomment-1\n");
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await client.addComment(42, "bounced (spec_ambiguous): missing AC detail");

    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "comment",
      "42",
      "--repo",
      "org/repo",
      "--body",
      "bounced (spec_ambiguous): missing AC detail",
    ]);
  });

  it("closeIssue closes with the given state_reason via --reason", async () => {
    const execFn = vi.fn(async () => "");
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await client.closeIssue(42, "completed");

    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "close",
      "42",
      "--repo",
      "org/repo",
      "--reason",
      "completed",
    ]);
  });

  it("closeIssue maps not_planned to gh's own 'not planned' reason string (gh's flag value has a space, unlike the API's state_reason)", async () => {
    const execFn = vi.fn(async () => "");
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await client.closeIssue(42, "not_planned");

    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "close",
      "42",
      "--repo",
      "org/repo",
      "--reason",
      "not planned",
    ]);
  });

  it("addComment throws a descriptive error when gh itself fails", async () => {
    const execFn = vi.fn(async () => {
      throw new Error("gh: authentication required");
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await expect(client.addComment(42, "x")).rejects.toThrow(/authentication required/);
  });

  it("closeIssue is a safe no-op (does not throw) when gh reports the issue is already closed", async () => {
    const execFn = vi.fn(async () => {
      throw new Error("GraphQL: Issue is already closed (closeIssue)");
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await expect(client.closeIssue(42, "completed")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- github-client`
Expected: FAIL — `src/github-client.ts` does not exist yet.

- [ ] **Step 3: Implement `src/github-client.ts`**

```typescript
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
}

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
 * case isn't a documented stable contract -- over-matching here just
 * risks swallowing a genuinely different close failure as a no-op, which
 * is an acceptable tradeoff for an operation whose whole purpose is
 * "don't fail if already done."
 */
function isAlreadyClosedError(message: string): boolean {
  return /already closed/i.test(message);
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
      "number,url",
    ]);
    const entries = JSON.parse(stdout) as GhIssueListEntry[];
    const first = entries[0];
    if (!first) return null;
    return { number: first.number, url: first.url };
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- github-client`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the full suite to verify nothing else broke**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 6: Commit**

```bash
git add src/github-client.ts test/github-client.test.ts
git commit -m "$(cat <<'EOF'
feat(github-client): add dev-loop's first GitHubClient (addComment, closeIssue, findIssueByJiraKey)

dev-loop has had zero GitHub write capability until now -- research-loop
creates the mirror Issue and writes recon/attack/verify content to it,
but once a ticket crosses to pipeline:dev, that Issue goes silent for
every outcome (bounce or landed). Mirrors research-loop's own
GitHubClient interface style and gh-CLI-shelling pattern. addComment/
closeIssue are the two methods this repo actually needs; findIssueByJiraKey
is ported unchanged since dev-loop has no other way to resolve a Jira key
to an issue number. closeIssue is a safe no-op on an already-closed issue,
required for the upcoming merge-reconciliation pass's idempotency.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `Config.github.repo` in dev-loop

**Files (dev-loop):**
- Modify: `src/types.ts` (add `github: { repo: string }` to `Config`)
- Modify: `src/config.ts` (`PLACEHOLDER_PATHS` gains `github.repo`)
- Modify: `test/config.test.ts`, `test/loop-runner.test.ts`,
  `test/jira-client.test.ts` (every `makeConfig()` needs `github.repo`)
- Modify: `pipeline.webtarsthree.config.json`,
  `pipeline.catalog-ui-management.config.json`,
  `pipeline.catalog-ui-public.config.json` (add `github.repo`, real
  values derived from each file's existing `targetRepo.url`)
- Modify: `docs/config.md` (document the new field)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Config.github.repo: string` — consumed by Task 5 (loop-runner
  wiring) and Task 6 (reconciliation pass) to construct `RealGitHubClient`.

Mirrors research-loop's already-shipped `Config.github.repo` field
exactly (same shape, same derivation rule: `owner/repo` from each
project's `targetRepo.url`). dev-loop's `Config` has no `jira.
mentionAccountId` equivalent to add here — that's research-loop-only
(the @-mention rule is research-loop's own routing-rule requirement); do
not add it to dev-loop's `Config` in this task.

- [ ] **Step 1: Write the failing test for `findPlaceholders` covering `github.repo`**

In `test/config.test.ts`, update `makeConfig()` to add, as a top-level
sibling of `jira`/`ceilings`/`autoPromoteLabel`/`targetRepo`:

```typescript
    github: { repo: "fandango/webtarsthree" },
```

Then add this test inside the `findPlaceholders / assertNoPlaceholders`
describe block:

```typescript
  it("lists github.repo when it's still set to the placeholder value", () => {
    const config = makeConfig({ github: { repo: "___" } });
    const missing = findPlaceholders(config);
    expect(missing).toContain("github.repo");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL — `Config` has no `github` field yet (compile error), and
`findPlaceholders` doesn't check `github.repo`.

- [ ] **Step 3: Add `github` to `Config` in `src/types.ts`**

As a new top-level sibling of `jira` in the `Config` interface (after the
closing `};` of `jira`, before `ceilings`), add:

```typescript
  /**
   * dev-loop's first GitHub write surface (addComment/closeIssue on the
   * mirror Issue research-loop already created). One target repo per
   * project config, same granularity as targetRepo -- derived from the
   * same codebase this repo's ticket-to-pr operates on, not a separate
   * system. Mirrors research-loop's own Config.github.repo field exactly.
   */
  github: {
    /** "owner/repo" shorthand, e.g. "fandango/webtarsthree" -- passed
     * directly to `gh`'s own --repo flag, which accepts this exact shape. */
    repo: string;
  };
```

- [ ] **Step 4: Add `github.repo` to `PLACEHOLDER_PATHS` in `src/config.ts`**

Add, after the `targetRepo.defaultBranch` entry (the last one in the
array):

```typescript
  ["github.repo", (c) => c.github.repo],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 6: Fix every other `Config`-literal test helper**

Add a top-level `github: { repo: "fandango/webtarsthree" }` (or the
generic `"org/repo"`-style value matching that file's existing
`targetRepo` convention) to:
- `test/loop-runner.test.ts`'s `makeConfig()`
- `test/jira-client.test.ts`'s `makeConfig()`

- [ ] **Step 7: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 8: Update the three project config files**

In `pipeline.webtarsthree.config.json`, add as a new top-level key (after
`targetRepo`): `"github": { "repo": "fandango/webtarsthree" }`.

In `pipeline.catalog-ui-management.config.json`, add: `"github": {
"repo": "fandango/catalog-ui-management" }`.

In `pipeline.catalog-ui-public.config.json`, add: `"github": { "repo":
"fandango/catalog-ui-public" }`.

- [ ] **Step 9: Update `docs/config.md`**

Add a new bullet to the config shape documentation (mirroring
research-loop's own `docs/config.md` wording for the identical field):

```markdown
- `github.repo` — the GitHub repo this project's mirror Issues live in
  (`"owner/repo"` shorthand, passed straight to `gh --repo`). One target
  repo per project config, same granularity as `targetRepo`. Mirrors
  research-loop's own `Config.github.repo` — research-loop creates the
  mirror Issue there; this repo's `GitHubClient` (`src/github-client.ts`)
  reads and writes to the same repo once a ticket crosses to
  `pipeline:dev`.
```

Also update "## Adding a new project" to note a new project also needs
its own `github.repo` value, matching research-loop's own doc.

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts test/loop-runner.test.ts test/jira-client.test.ts pipeline.webtarsthree.config.json pipeline.catalog-ui-management.config.json pipeline.catalog-ui-public.config.json docs/config.md
git commit -m "$(cat <<'EOF'
feat(config): add Config.github.repo, dev-loop's half of the GitHub Issue mirror

Mirrors research-loop's own Config.github.repo field exactly -- the
mirror Issue's target repo, one per project, derived from each config's
existing targetRepo.url. Consumed by the next task's GitHubClient wiring
into loop-runner.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `GitHubClient.addComment` into `loop-runner.ts`'s bounce/landed paths

**Files (dev-loop):**
- Modify: `src/loop-runner.ts`
- Modify: `test/loop-runner.test.ts`

**Interfaces:**
- Consumes: `GitHubClient` (Task 3), `Config.github.repo` (Task 4).
- Produces: `LoopIterationDeps` gains a `githubClient: GitHubClient`
  field; `runLoopIteration` now also posts a GitHub Issue comment on
  every bounce and every landed verdict, mirroring research-loop's own
  Jira-brief/GitHub-full routing rule. Task 6 (reconciliation pass) is
  independent of this task's specific call sites but shares the same
  `githubClient` dependency shape.

**Design decision this task makes** (per the routing rule research-loop
already established and per this session's item 2 framing: "route
bounce/pass detail to the mirrored GitHub Issue, same routing rule
research-loop already follows — Jira stays a brief pointer, GitHub
carries full context"):

- On a **genuine bounce** (same condition already guarding the existing
  `Blocked` transition: `verdict.outcome === "bounced" && verdict.pr ===
  null`): after posting the existing Jira bounce comment (unchanged),
  look up the mirror Issue via `githubClient.findIssueByJiraKey(ticket.
  key)` and post the **full** bounce detail there via `addComment` — not
  just the fixed three-line header Jira gets, but `verdict.detail` in
  full (Jira's own comment, per Task 8 below, keeps a terser version).
- On a **landed** verdict (`verdict.outcome === "landed"`): after the
  existing Code Review transition, also post a landed-detail comment to
  the mirror Issue via `addComment` (PR URL, verify-loop count) — dev-loop
  today writes *nothing* to the mirror Issue on a landed verdict, which
  `future-enhancements.md` calls out explicitly as part of the same gap
  ("goes silent... no bounce detail, no pass/fail info, nothing, for any
  outcome").
- Both writes are **non-fatal**: wrapped in their own try/catch, folded
  into the existing `jiraSyncError` accumulator (rename tolerated by
  existing tests reading it — no rename needed, `jiraSyncError` already
  accumulates multiple failure sources via string concatenation). A
  missing mirror Issue (`findIssueByJiraKey` returns `null` — e.g. this
  ticket predates research-loop's Phase 1) is **not an error**: log and
  skip the GitHub write silently, matching the same "don't invent
  content that doesn't exist" discipline already used elsewhere in this
  pipeline.

- [ ] **Step 1: Write the failing test for a bounce posting to the mirror Issue**

In `test/loop-runner.test.ts`, add `githubClient` to `makeDeps()`'s
defaults:

```typescript
function makeMockGitHubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "https://github.com/org/repo/issues/42" })),
    addComment: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    ...overrides,
  };
}
```

Add the import at the top: `import type { GitHubClient } from
"../src/github-client.ts";`

Update `makeDeps()`:
```typescript
function makeDeps(overrides: Partial<LoopIterationDeps> = {}): LoopIterationDeps {
  return {
    jiraClient: makeMockJiraClient(),
    githubClient: makeMockGitHubClient(),
    config: makeConfig(),
    runSkill: vi.fn(),
    loopKind: "dev",
    runsLogPath: "",
    runsToday: 0,
    assigneeAccountId: ASSIGNEE_ACCOUNT_ID,
    ...overrides,
  };
}
```

Then add these tests, right after the existing "a genuine bounce (no PR
yet) posts the verdict's evidence as a Jira comment before transitioning
to Blocked" test:

```typescript
  it("a genuine bounce also posts the full verdict detail to the mirror GitHub Issue, found by Jira key", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const githubClient = makeMockGitHubClient();
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => makeTicket()),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({
          outcome: "bounced",
          pr: null,
          failure_category: "spec_ambiguous",
          detail: "the full bounce detail, longer than Jira's own terser comment",
        }),
        started: "2026-01-01T00:00:00.000Z",
        ended: "2026-01-01T00:01:00.000Z",
        costUsd: 0.5,
        tokens: { in: 100, out: 50 },
      }));

      await runLoopIteration(
        makeDeps({ jiraClient, githubClient, runSkill, runsLogPath }),
      );

      expect(githubClient.findIssueByJiraKey).toHaveBeenCalledWith("PROJ-1");
      expect(githubClient.addComment).toHaveBeenCalledWith(
        42,
        expect.stringContaining("the full bounce detail, longer than Jira's own terser comment"),
      );
    });
  });

  it("a landed verdict also posts PR/verify-loop detail to the mirror GitHub Issue", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const githubClient = makeMockGitHubClient();
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => makeTicket()),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed", pr: "https://github.com/org/repo/pull/9" }),
        started: "2026-01-01T00:00:00.000Z",
        ended: "2026-01-01T00:01:00.000Z",
        costUsd: 0.5,
        tokens: { in: 100, out: 50 },
      }));

      await runLoopIteration(
        makeDeps({ jiraClient, githubClient, runSkill, runsLogPath }),
      );

      expect(githubClient.addComment).toHaveBeenCalledWith(
        42,
        expect.stringContaining("https://github.com/org/repo/pull/9"),
      );
    });
  });

  it("when no mirror Issue is found for this ticket, skips the GitHub write silently -- never an error", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const githubClient = makeMockGitHubClient({
        findIssueByJiraKey: vi.fn(async () => null),
      });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => makeTicket()),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed", pr: "https://github.com/org/repo/pull/9" }),
        started: "2026-01-01T00:00:00.000Z",
        ended: "2026-01-01T00:01:00.000Z",
        costUsd: 0.5,
        tokens: { in: 100, out: 50 },
      }));

      const result = await runLoopIteration(
        makeDeps({ jiraClient, githubClient, runSkill, runsLogPath }),
      );

      expect(githubClient.addComment).not.toHaveBeenCalled();
      expect(result.kind).toBe("ran");
      expect(result.jiraSyncError).toBeUndefined();
    });
  });

  it("a GitHub addComment failure never throws out of runLoopIteration -- surfaced via jiraSyncError, and the Jira-side work still completes", async () => {
    await withTempRunsLog(async (runsLogPath) => {
      const githubClient = makeMockGitHubClient({
        addComment: vi.fn(async () => {
          throw new Error("gh: rate limited");
        }),
      });
      const jiraClient = makeMockJiraClient({
        pollOldestMatching: vi.fn(async () => makeTicket()),
      });
      const runSkill: RunSkillFn = vi.fn(async () => ({
        verdict: makeVerdict({ outcome: "landed", pr: "https://github.com/org/repo/pull/9" }),
        started: "2026-01-01T00:00:00.000Z",
        ended: "2026-01-01T00:01:00.000Z",
        costUsd: 0.5,
        tokens: { in: 100, out: 50 },
      }));

      const result = await runLoopIteration(
        makeDeps({ jiraClient, githubClient, runSkill, runsLogPath }),
      );

      expect(result.kind).toBe("ran");
      expect(result.jiraSyncError).toContain("rate limited");
      expect(jiraClient.transitionStatus).toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- loop-runner`
Expected: FAIL — `LoopIterationDeps` has no `githubClient` field yet
(compile error), and `runLoopIteration` never calls `addComment`.

- [ ] **Step 3: Add `githubClient` to `LoopIterationDeps` and wire the two call sites**

In `src/loop-runner.ts`, add the import:
```typescript
import type { GitHubClient } from "./github-client.ts";
```

Add `githubClient: GitHubClient;` to `LoopIterationDeps`, right after
`jiraClient: JiraClient;`.

Destructure it at the top of `runLoopIteration`:
```typescript
  const { jiraClient, githubClient, config, runSkill, loopKind, runsLogPath, runsToday, assigneeAccountId } =
    deps;
```

Add a small helper right above `runLoopIteration` (or as a local function
within the same module, near `buildBounceCommentAdf`):

```typescript
/**
 * Post detail to the mirror GitHub Issue for this ticket, if one exists.
 * Non-fatal: a lookup/post failure or a missing Issue never throws --
 * folded into jiraSyncError (lookup/post failure) or silently skipped
 * (no Issue found), since a ticket predating research-loop's Phase 1
 * mirror-Issue rollout is an expected case, not an error.
 */
async function postGitHubDetail(
  githubClient: GitHubClient,
  ticketKey: string,
  body: string,
): Promise<string | undefined> {
  try {
    const issue = await githubClient.findIssueByJiraKey(ticketKey);
    if (!issue) return undefined;
    await githubClient.addComment(issue.number, body);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
```

In the existing `try` block that already handles the landed/bounced
branches (the one starting `let jiraSyncError: string | undefined =
assignSyncError; try { if (loopKind === "dev" && verdict.outcome ===
"landed") {`), add the GitHub write right after each branch's existing
Jira work, merging any error into `jiraSyncError` the same way the
existing bounce-comment try/catch already does:

For the landed branch, right after the existing `await jiraClient.
transitionStatus(...)` call:
```typescript
      const githubError = await postGitHubDetail(
        githubClient,
        ticket.key,
        `Landed — PR: ${verdict.pr ?? "(none)"}, verify loops: ${verdict.verify_loops}.`,
      );
      if (githubError) {
        jiraSyncError = jiraSyncError ? `${jiraSyncError}; ${githubError}` : githubError;
      }
```

For the bounced branch, right after the existing `await jiraClient.
addComment(ticket.key, buildBounceCommentAdf(verdict));` try/catch block
(before the `await jiraClient.transitionStatus(ticket.key, config.jira.
statusNames.bounced);` line):
```typescript
      const githubError = await postGitHubDetail(
        githubClient,
        ticket.key,
        `Bounced (${verdict.failure_category}): ${verdict.detail}`,
      );
      if (githubError) {
        jiraSyncError = jiraSyncError ? `${jiraSyncError}; ${githubError}` : githubError;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- loop-runner`
Expected: PASS.

- [ ] **Step 5: Run the full suite to verify nothing else broke**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 6: Commit**

```bash
git add src/loop-runner.ts test/loop-runner.test.ts
git commit -m "$(cat <<'EOF'
feat(loop-runner): post bounce/landed detail to the mirror GitHub Issue

dev-loop wrote nothing to the mirror Issue on any outcome -- once a
ticket crossed to pipeline:dev, GitHub Issue context-tracking stopped
entirely. Mirrors research-loop's own Jira-brief/GitHub-full routing
rule: on a genuine bounce, the full verdict detail now also posts to the
mirror Issue (found via GitHubClient.findIssueByJiraKey); on landed, PR
URL + verify-loop count posts too. Both non-fatal, folded into the
existing jiraSyncError accumulator; a missing mirror Issue (ticket
predates research-loop's Phase 1) is silently skipped, not an error.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: dev-loop's startup-time merge-reconciliation pass

**Files (dev-loop):**
- Create: `src/reconcile.ts`
- Test: `test/reconcile.test.ts`
- Modify: `src/main.ts` (call the pass once per poll cycle, before
  `runLoopIteration`)
- Modify: `docs/config.md` (document the pass)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `JiraClient.pollOldestMatching`... actually needs a
  multi-ticket query, not single-ticket — see Step 3's new `JiraClient`
  method below. Also consumes `GitHubClient.closeIssue`/
  `findIssueByJiraKey` (Task 3), `RunLogLine` (existing, from
  `runs-log.ts`), an injected `execGhPrView` function for `gh pr view`.
- Produces: `reconcileMergedTickets(deps): Promise<ReconcileResult>` — a
  pure, injected-dependency function (mirrors `runLoopIteration`'s own
  shape) callable once per poll cycle from `main.ts`, before
  `runLoopIteration`. `ReconcileResult = { checked: number; closed:
  string[]; errors: Array<{ ticket: string; message: string }> }`.

**Design decision this task makes** (per the decided tradeoff above):
this pass finds candidates via a **new JQL query** — tickets carrying
`handoffLabel` at status `statusNames.prOpen` — rather than iterating
`runs.jsonl` (which only has this *process's own* run history, not a
live "which tickets are currently at Code Review" view; a ticket could
be at Code Review from a run that happened before this pass existed).
This needs a new `JiraClient` method, since `pollOldestMatching` returns
only one ticket:

- [ ] **Step 1: Write the failing test for `JiraClient.pollAllMatching`**

In `test/jira-client.test.ts`, add this test inside a new `describe
("RealJiraClient.pollAllMatching", ...)` block, following the existing
pattern used for `pollOldestMatching`'s own tests (find that describe
block first and mirror its `fetchMock`/`vi.stubGlobal` setup exactly):

```typescript
describe("RealJiraClient.pollAllMatching", () => {
  it("returns every matching ticket, not just the oldest", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          issues: [
            { key: "PROJ-1", fields: { status: { name: "Code Review" }, assignee: { accountId: "user-123" } } },
            { key: "PROJ-2", fields: { status: { name: "Code Review" }, assignee: null } },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const tickets = await client.pollAllMatching('labels = "pipeline:dev"');

    expect(tickets).toEqual([
      { key: "PROJ-1", status: "Code Review", assignee: "user-123" },
      { key: "PROJ-2", status: "Code Review", assignee: null },
    ]);
  });

  it("returns an empty array when nothing matches", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ issues: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RealJiraClient(CREDENTIALS, makeConfig());

    const tickets = await client.pollAllMatching('labels = "pipeline:dev"');

    expect(tickets).toEqual([]);
  });
});
```

(Check the existing `pollOldestMatching` describe block first for the
exact `fetchMock`/JQL-request-shape/`Response` construction convention
already used in this file — mirror it exactly rather than inventing a
new mocking style. If `pollOldestMatching`'s existing tests use a
different response shape than sketched above, match theirs instead of
this sketch.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- jira-client`
Expected: FAIL — `pollAllMatching` does not exist on `RealJiraClient`.

- [ ] **Step 3: Add `pollAllMatching` to `JiraClient` and `RealJiraClient`**

In `src/jira-client.ts`, add to the `JiraClient` interface (right after
`pollOldestMatching`'s own declaration):

```typescript
  /**
   * Poll Jira for every ticket matching the given JQL (not just the
   * oldest) -- used by the merge-reconciliation pass, which needs to
   * check every ticket currently at Code Review, not claim one at a time
   * the way the main poll loop does.
   */
  pollAllMatching(jql: string): Promise<JiraTicket[]>;
```

Add the same method to `StubJiraClient` (throwing, matching the existing
stub pattern for every other method in that class):

```typescript
  async pollAllMatching(_jql: string): Promise<JiraTicket[]> {
    throw new Error(UNCONFIGURED_MESSAGE("pollAllMatching"));
  }
```

Add the real implementation to `RealJiraClient`. First read how
`pollOldestMatching` builds its request (same file, nearby) — reuse the
exact same `/rest/api/3/search` request shape and just return every
issue instead of only `issues[0]`:

```typescript
  async pollAllMatching(jql: string): Promise<JiraTicket[]> {
    const response = await this.request(
      `/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=status,assignee`,
    );
    const data = (await response.json()) as JiraSearchResponse;
    return data.issues.map((issue) => ({
      key: issue.key,
      status: issue.fields.status.name,
      assignee: issue.fields.assignee?.accountId ?? null,
    }));
  }
```

(Match this exactly to whatever `pollOldestMatching`'s own real
implementation already does for the request URL/fields/type names —
`JiraSearchResponse` should already exist as a type in this file since
`pollOldestMatching` needs the same shape; if its existing type is named
differently, use that name instead of inventing `JiraSearchResponse`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- jira-client`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `reconcileMergedTickets`**

Create `test/reconcile.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { reconcileMergedTickets } from "../src/reconcile.ts";
import type { JiraClient, JiraTicket } from "../src/jira-client.ts";
import type { GitHubClient } from "../src/github-client.ts";
import type { Config, RunLogLine } from "../src/types.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeConfig(): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      repoLabel: "repo:webtarsthree",
      claimStatus: { from: "Ready", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" ORDER BY created ASC',
        dev: 'labels = "{label}" AND status != "{bouncedStatus}" ORDER BY created ASC',
      },
      statusNames: { bounced: "Blocked", prOpen: "Code Review" },
      codeReviewFields: {
        piiField: "customfield_13504",
        piiNoImpactOptionId: "14310",
        qaNotesField: "customfield_14226",
      },
    },
    github: { repo: "org/repo" },
    ceilings: { maxRunsPerDay: 10, maxCostPerRunUsd: 5, runTimeoutMin: 30 },
    autoPromoteLabel: "auto-promote",
    targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  };
}

function makeTicket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return { key: "PROJ-1", status: "Code Review", assignee: "user-123", ...overrides };
}

function makeRunLogLine(overrides: Partial<RunLogLine> = {}): RunLogLine {
  return {
    ticket: "PROJ-1",
    skill: "ticket-to-pr",
    skill_version: "abc1234",
    model: "sonnet",
    started: "2026-01-01T00:00:00.000Z",
    ended: "2026-01-01T00:10:00.000Z",
    outcome: "landed",
    phase_reached: "pr",
    red_confirmed: true,
    verify_loops: 1,
    retries: 0,
    failure_category: null,
    detail: "landed",
    pr: "https://github.com/org/repo/pull/9",
    cost_usd: 1.0,
    tokens: { in: 100, out: 50 },
    ...overrides,
  };
}

async function withRunsLog(lines: RunLogLine[], fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "reconcile-test-"));
  const path = join(dir, "runs.jsonl");
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("reconcileMergedTickets", () => {
  it("finds a Code-Review ticket whose PR merged, and closes the mirror Issue", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => [makeTicket()]),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
      };
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "https://github.com/org/repo/issues/42" })),
        addComment: vi.fn(),
        closeIssue: vi.fn(async () => {}),
      };
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" }));

      const result = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config: makeConfig(),
        runsLogPath,
        execGhPrView,
      });

      expect(result).toEqual({ checked: 1, closed: ["PROJ-1"], errors: [] });
      expect(githubClient.closeIssue).toHaveBeenCalledWith(42, "completed");
    });
  });

  it("does nothing for a Code-Review ticket whose PR is still open", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => [makeTicket()]),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
      };
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "x" })),
        addComment: vi.fn(),
        closeIssue: vi.fn(),
      };
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "OPEN", mergedAt: null }));

      const result = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config: makeConfig(),
        runsLogPath,
        execGhPrView,
      });

      expect(result).toEqual({ checked: 1, closed: [], errors: [] });
      expect(githubClient.closeIssue).not.toHaveBeenCalled();
    });
  });

  it("is a safe no-op when no ticket is at Code Review", async () => {
    await withRunsLog([], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => []),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
      };
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(),
        addComment: vi.fn(),
        closeIssue: vi.fn(),
      };
      const execGhPrView = vi.fn();

      const result = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config: makeConfig(),
        runsLogPath,
        execGhPrView,
      });

      expect(result).toEqual({ checked: 0, closed: [], errors: [] });
      expect(execGhPrView).not.toHaveBeenCalled();
    });
  });

  it("skips a Code-Review ticket with no 'landed' line in runs.jsonl (no PR URL to check), recording it as an error, not a crash", async () => {
    await withRunsLog([], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => [makeTicket()]),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
      };
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(),
        addComment: vi.fn(),
        closeIssue: vi.fn(),
      };
      const execGhPrView = vi.fn();

      const result = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config: makeConfig(),
        runsLogPath,
        execGhPrView,
      });

      expect(result.checked).toBe(1);
      expect(result.closed).toEqual([]);
      expect(result.errors).toEqual([
        { ticket: "PROJ-1", message: expect.stringContaining("no landed run found") },
      ]);
      expect(execGhPrView).not.toHaveBeenCalled();
    });
  });

  it("re-running on an already-closed mirror Issue is a safe no-op -- idempotency guard", async () => {
    await withRunsLog([makeRunLogLine()], async (runsLogPath) => {
      const jiraClient: JiraClient = {
        pollOldestMatching: vi.fn(),
        pollAllMatching: vi.fn(async () => [makeTicket()]),
        claimTicket: vi.fn(),
        transitionStatus: vi.fn(),
        swapLabel: vi.fn(),
        assignTicket: vi.fn(),
        addComment: vi.fn(),
      };
      // closeIssue itself is already a safe no-op on an already-closed
      // issue (see Task 3) -- this test just confirms reconcile still
      // reports the ticket as "closed" (its merge was confirmed) even on
      // a second pass, and doesn't error just because gh reports it as
      // already closed.
      const githubClient: GitHubClient = {
        findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "x" })),
        addComment: vi.fn(),
        closeIssue: vi.fn(async () => {}), // real RealGitHubClient already swallows "already closed"
      };
      const execGhPrView = vi.fn(async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" }));

      const first = await reconcileMergedTickets({ jiraClient, githubClient, config: makeConfig(), runsLogPath, execGhPrView });
      const second = await reconcileMergedTickets({ jiraClient, githubClient, config: makeConfig(), runsLogPath, execGhPrView });

      expect(first.closed).toEqual(["PROJ-1"]);
      expect(second.closed).toEqual(["PROJ-1"]);
      expect(second.errors).toEqual([]);
    });
  });

  it("a gh pr view failure for one ticket is recorded as an error and does not stop the pass from checking the rest", async () => {
    await withRunsLog(
      [
        makeRunLogLine({ ticket: "PROJ-1", pr: "https://github.com/org/repo/pull/9" }),
        makeRunLogLine({ ticket: "PROJ-2", pr: "https://github.com/org/repo/pull/10" }),
      ],
      async (runsLogPath) => {
        const jiraClient: JiraClient = {
          pollOldestMatching: vi.fn(),
          pollAllMatching: vi.fn(async () => [makeTicket({ key: "PROJ-1" }), makeTicket({ key: "PROJ-2" })]),
          claimTicket: vi.fn(),
          transitionStatus: vi.fn(),
          swapLabel: vi.fn(),
          assignTicket: vi.fn(),
          addComment: vi.fn(),
        };
        const githubClient: GitHubClient = {
          findIssueByJiraKey: vi.fn(async () => ({ number: 42, url: "x" })),
          addComment: vi.fn(),
          closeIssue: vi.fn(async () => {}),
        };
        const execGhPrView = vi.fn(async (url: string) => {
          if (url.includes("/9")) throw new Error("gh: network error");
          return JSON.stringify({ state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" });
        });

        const result = await reconcileMergedTickets({
          jiraClient,
          githubClient,
          config: makeConfig(),
          runsLogPath,
          execGhPrView,
        });

        expect(result.checked).toBe(2);
        expect(result.closed).toEqual(["PROJ-2"]);
        expect(result.errors).toEqual([{ ticket: "PROJ-1", message: expect.stringContaining("network error") }]);
      },
    );
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- reconcile`
Expected: FAIL — `src/reconcile.ts` does not exist yet.

- [ ] **Step 7: Implement `src/reconcile.ts`**

```typescript
/**
 * dev-loop's startup-time merge-reconciliation pass. Per
 * docs/future-enhancements.md's Jira label-based trigger design: nothing
 * in this pipeline reacts to a GitHub PR merge event -- GitHub's own
 * "Closes #N" convention auto-closes the mirror Issue on a merge that
 * happens while dev-loop is running, but a merge that happens while
 * dev-loop is offline (or a PR that predates that convention being used)
 * can't assume the auto-close already ran. This pass finds every ticket
 * currently sitting at Code Review (handoffLabel + statusNames.prOpen),
 * resolves each one's PR URL from its own runs.jsonl history (the most
 * recent "landed" line for that ticket key -- no new field needed,
 * RunLogLine.pr already carries it), checks the real merge state via
 * `gh pr view --json state,mergedAt`, and for any that merged, closes the
 * mirror GitHub Issue (state_reason "completed"). Deliberately does NOT
 * touch the Jira ticket's own status/label -- a human closes the Jira
 * ticket by hand; this pass only keeps the GitHub Issue from going stale.
 * This is a startup-time/per-poll-cycle reconciliation step, not a
 * separately-scheduled job or webhook -- called once per iteration from
 * main.ts's poll loop, before runLoopIteration.
 */

import type { JiraClient } from "./jira-client.ts";
import type { GitHubClient } from "./github-client.ts";
import type { Config } from "./types.ts";
import { readRunLog } from "./runs-log.ts";
import { buildDevJql } from "./jql.ts";

/** Stand-in for `gh pr view <url> --json state,mergedAt`, returning its raw JSON stdout. Injected so tests never shell out for real. */
export type ExecGhPrViewFn = (prUrl: string) => Promise<string>;

export interface ReconcileDeps {
  jiraClient: JiraClient;
  githubClient: GitHubClient;
  config: Config;
  runsLogPath: string;
  execGhPrView: ExecGhPrViewFn;
}

export interface ReconcileResult {
  /** How many Code-Review tickets this pass examined. */
  checked: number;
  /** Ticket keys whose PR was confirmed merged and whose mirror Issue was closed this pass (or already closed -- see closeIssue's own idempotency). */
  closed: string[];
  /** Per-ticket failures -- a gh/GitHub call that failed for one ticket never stops the pass from checking the rest. */
  errors: Array<{ ticket: string; message: string }>;
}

interface GhPrViewResult {
  state: string;
  mergedAt: string | null;
}

/**
 * Build the JQL for "tickets at Code Review" -- handoffLabel (the same
 * label pollJql.dev already matches on) plus status = statusNames.prOpen.
 * A separate template from pollJql.dev itself (that one now also excludes
 * bounced-status tickets, which is irrelevant here -- Code Review status
 * is never bounced status).
 */
function buildPrOpenJql(config: Config): string {
  return `labels = "${config.jira.handoffLabel}" AND labels = "${config.jira.repoLabel}" AND status = "${config.jira.statusNames.prOpen}" ORDER BY created ASC`;
}

/** Find the most recent "landed" run for this ticket key in runs.jsonl, or null if none exists. */
async function findLandedPrUrl(runsLogPath: string, ticketKey: string): Promise<string | null> {
  let lines;
  try {
    lines = await readRunLog(runsLogPath);
  } catch {
    return null;
  }
  const landedLines = lines.filter((l) => l.ticket === ticketKey && l.outcome === "landed" && l.pr);
  const last = landedLines[landedLines.length - 1];
  return last?.pr ?? null;
}

export async function reconcileMergedTickets(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { jiraClient, githubClient, config, runsLogPath, execGhPrView } = deps;

  const jql = buildPrOpenJql(config);
  const tickets = await jiraClient.pollAllMatching(jql);

  const result: ReconcileResult = { checked: tickets.length, closed: [], errors: [] };

  for (const ticket of tickets) {
    try {
      const prUrl = await findLandedPrUrl(runsLogPath, ticket.key);
      if (!prUrl) {
        result.errors.push({
          ticket: ticket.key,
          message: `no landed run found in ${runsLogPath} for ${ticket.key} -- cannot determine its PR URL`,
        });
        continue;
      }

      const raw = await execGhPrView(prUrl);
      const prStatus = JSON.parse(raw) as GhPrViewResult;

      if (!prStatus.mergedAt) {
        continue;
      }

      const issue = await githubClient.findIssueByJiraKey(ticket.key);
      if (issue) {
        await githubClient.closeIssue(issue.number, "completed");
      }
      result.closed.push(ticket.key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ ticket: ticket.key, message });
    }
  }

  return result;
}

/**
 * Real ExecGhPrViewFn for production wiring: spawns
 * `gh pr view <url> --json state,mergedAt`, returning stdout.
 */
export function realExecGhPrView(): ExecGhPrViewFn {
  return async (prUrl: string): Promise<string> => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync("gh", [
        "pr",
        "view",
        prUrl,
        "--json",
        "state,mergedAt",
      ]);
      return stdout;
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(stderr ? `${message}: ${stderr}` : message);
    }
  };
}
```

Note: `buildDevJql` is imported but unused in the sketch above — remove
that import; `buildPrOpenJql` is its own template, not built from
`pollJql.dev`. (Left as a note here rather than in the code itself: don't
copy the unused import into the real file.)

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- reconcile`
Expected: PASS (6 tests).

- [ ] **Step 9: Run the full suite to verify nothing else broke**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 10: Wire the pass into `main.ts`'s poll loop**

In `src/main.ts`, add the imports:
```typescript
import { RealGitHubClient, realExecGh } from "./github-client.ts";
import { reconcileMergedTickets, realExecGhPrView } from "./reconcile.ts";
```

After the existing `const jiraClient = new RealJiraClient(credentials,
config);` line, add:
```typescript
  const githubClient = new RealGitHubClient(config.github, realExecGh());
```

Inside the `for (;;)` poll loop, right before the existing `const result
= await runLoopIteration({...})` call, add:
```typescript
    try {
      const reconcileResult = await reconcileMergedTickets({
        jiraClient,
        githubClient,
        config,
        runsLogPath,
        execGhPrView: realExecGhPrView(),
      });
      if (reconcileResult.closed.length > 0) {
        log(`[${SKILL_NAME}] reconciliation: closed mirror Issue(s) for ${reconcileResult.closed.join(", ")}`);
      }
      for (const err of reconcileResult.errors) {
        logError(`[${SKILL_NAME}] reconciliation: ${err.ticket}: ${err.message}`);
      }
    } catch (err) {
      // The reconciliation pass itself must never throw out of the poll
      // loop -- same never-throw contract every other I/O boundary in
      // this file already follows. A failure here just means this
      // cycle's reconciliation didn't run; the next cycle tries again.
      const message = err instanceof Error ? err.message : String(err);
      logError(`[${SKILL_NAME}] reconciliation pass failed: ${message}`);
    }

```

Also pass `githubClient` into the existing `runLoopIteration({...})` call
(Task 5 added this dependency to `LoopIterationDeps`):
```typescript
    const result = await runLoopIteration({
      jiraClient,
      githubClient,
      config,
      runSkill,
      loopKind: "dev",
      runsLogPath,
      runsToday,
      assigneeAccountId,
    });
```

- [ ] **Step 11: Manually verify `main.ts` still type-checks**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 12: Run the full suite one more time**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 13: Update `docs/config.md`**

Add a new section, after "## Code Review transition screen fields":

```markdown
## Startup-time merge-reconciliation pass

At the top of every poll cycle (before `runLoopIteration`), `main.ts`
runs `reconcileMergedTickets` (`src/reconcile.ts`): finds every ticket at
`handoffLabel` + `statusNames.prOpen` (Code Review) via a new
`JiraClient.pollAllMatching` query, resolves each one's PR URL from the
most recent `"landed"` line in `runs/<slug>.jsonl` for that ticket key,
and checks the real merge state via `gh pr view <url> --json
state,mergedAt`. For any that merged, closes the mirror GitHub Issue
(`state_reason: "completed"`) via `GitHubClient.closeIssue` — but does
**not** touch the Jira ticket's status or label. A human still closes the
Jira ticket by hand; this pass exists only so the GitHub Issue doesn't
stay open indefinitely after a merge that happened while dev-loop was
offline (GitHub's own `Closes #N` convention auto-closes the Issue on a
merge that happens while dev-loop is *running*, but a merge missed while
offline needs this catch-up).

This is a narrower scope than the original Jira-label-trigger design
sketched (`pipeline:dev` → `pipeline:merged`, both systems) — that design
depended on a `stageLabels`/`pipeline:pr-open` label scheme that was
never built (see research-loop's `docs/future-enhancements.md`'s
checkpoint section). Reopening the full label-based version is tracked
there, not here.

A ticket with no `"landed"` line in its own `runs.jsonl` (e.g. it reached
Code Review through a means this pass can't trace a PR URL from) is
recorded as a per-ticket error and skipped, not a crash — the pass keeps
checking every other candidate ticket regardless. Idempotent by
construction: `GitHubClient.closeIssue` is itself a safe no-op on an
already-closed issue, so re-running this pass on a ticket whose Issue is
already closed just re-confirms the merge and reports it closed again,
without erroring.
```

- [ ] **Step 14: Add a `CHANGELOG.md` entry**

```markdown
## 2026-09-17 — startup-time merge-reconciliation pass, closes the mirror Issue on merge

Nothing in this pipeline reacted to a GitHub PR merge event -- GitHub's
own "Closes #N" auto-close only fires while dev-loop happens to be
running at merge time. Added `reconcileMergedTickets`
(`src/reconcile.ts`), run once per poll cycle before `runLoopIteration`:
finds every ticket at Code Review via a new `JiraClient.pollAllMatching`
query, resolves its PR URL from `runs.jsonl`'s own history, checks
`gh pr view --json state,mergedAt`, and closes the mirror GitHub Issue on
a confirmed merge. Deliberately does not touch the Jira ticket itself --
narrower than the original Jira-label-trigger design's full
`pipeline:dev`→`pipeline:merged` swap, since the label scheme that
depended on (`stageLabels`/`pipeline:pr-open`) was never built. See
research-loop's `docs/future-enhancements.md` for the full history.
```

- [ ] **Step 15: Commit**

```bash
git add src/reconcile.ts test/reconcile.test.ts src/jira-client.ts test/jira-client.test.ts src/main.ts docs/config.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat(reconcile): startup-time merge-reconciliation pass, closes the mirror Issue on merge

Adds reconcileMergedTickets, run once per poll cycle before
runLoopIteration: finds tickets at Code Review (handoffLabel +
statusNames.prOpen) via a new JiraClient.pollAllMatching query, resolves
each one's PR URL from runs.jsonl's own "landed" history, checks
gh pr view --json state,mergedAt, and closes the mirror GitHub Issue on a
confirmed merge via GitHubClient.closeIssue. Deliberately does not
transition the Jira ticket itself -- a human closes it by hand. Narrower
than the original Jira-label-trigger design's pipeline:merged swap, since
that depended on an abandoned stageLabels scheme.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: research-loop — simplify Jira/GitHub comment templates (routing rule + re-pickup matching)

**Files (research-loop):**
- Modify: `.claude/skills/ticket-refine/SKILL.md`
- Modify: `docs/skills.md`
- Modify: `CHANGELOG.md`

**Interfaces:** none code-level — this is a `SKILL.md` content change
research-loop's Claude-invoked skill reads at run time, not a `src/`
change. No test file (this repo's own skills aren't unit-tested code;
`docs/skills.md`'s own convention already documents this).

Per `future-enhancements.md`'s "Simplify Jira/GitHub comment templates"
entry, apply the three decided changes:

1. Drop the mandatory `@`-mention from every Jira comment template.
2. Replace the fixed titles (`Refined Spec — ready for ticket-to-pr`,
   `Ticket-Refine Bounce — <failure_category>`) with `{✅|❌} research-loop
   - <short context>`.
3. Replace the `Full Overview / Acceptance Criteria (N ACs) / Scope
   write-up: <raw URL>` pointer line with `[GitHub Issue](<url>)`.

Also update the **re-pickup detection** logic this same file's "Setup:
idempotent re-refinement" section describes, since it currently greps
for the *old* fixed title strings.

- [ ] **Step 1: Update the "Setup: idempotent re-refinement" section**

In `.claude/skills/ticket-refine/SKILL.md`, replace the section starting
"**Always check first**: does this ticket already have a `Refined Spec —
ready for ticket-to-pr` comment (Jira) or an equivalent `## Refined Spec —
ready for ticket-to-pr` comment on the mirror GitHub Issue (Step 0.5)?"
with:

```markdown
**Always check first**: does this ticket already have a research-loop
Jira comment (title starts with `✅ research-loop -` or `❌ research-loop
-`) or an equivalent GitHub Issue comment (first line starts with `##
✅ research-loop -` or `## ❌ research-loop -`)? Either is evidence of a
prior pass — match on the leading icon + `research-loop -` prefix, not
the old fixed strings (`Refined Spec — ready for ticket-to-pr`,
`Ticket-Refine Bounce — <category>`) that this convention replaces; this
skill no longer writes those.
```

- [ ] **Step 2: Rewrite the "Ticket content protocol" section's routing rule**

Locate the block starting "**Every Jira comment written under this
protocol must @-mention `jira.mentionAccountId`**" (per the grep results
from planning, around line 511) and replace it with:

```markdown
**No mandatory @-mention.** Earlier revisions of this protocol required
@-mentioning `jira.mentionAccountId` on every Jira comment; confirmed
excessive in practice (real example: TARS-1462's Jira comment,
2026-09-16). Comments no longer @-mention anyone. `jira.mentionAccountId`
itself stays in config as an unused field for now — removing it is its
own small cleanup, not bundled here.

**Comment title convention, both outcomes:**

```
{✅|❌} research-loop - <short context>
```

`✅` = passing/landed verdict, `❌` = bounced. `<short context>` is a
one-line human-readable summary of the ticket's substance — for a bounce,
still make the failure category obvious in plain language (e.g. `❌
research-loop - scope too large, needs split`, not `❌ research-loop -
too_large`). This replaces the old fixed titles (`Refined Spec — ready
for ticket-to-pr`, `Ticket-Refine Bounce — <failure_category>`) outright
— no transition period; re-pickup only needs to find *a* matching
comment (per "Setup: idempotent re-refinement" above), not preserve
historically-titled ones.

**Clean issue link, no section manifest.** Where this protocol previously
pointed to the GitHub Issue via `Full Overview / Acceptance Criteria (N
ACs) / Scope write-up: <raw URL>`, use a single clean markdown link
instead:

```
[GitHub Issue](<url>)
```

on both a passing-verdict pointer and a bounce's evidence-pointer.
```

- [ ] **Step 3: Update the passing-verdict comment instructions**

Find the numbered "Ticket content protocol" list item describing the
passing-verdict Jira comment (item 2, per planning's grep — the one
starting "**On a passing verdict**, write **one Jira comment**, titled
exactly `Refined Spec — ready for ticket-to-pr`, @-mentioning
`jira.mentionAccountId`, containing:"). Replace it with:

```markdown
2. **On a passing verdict**, write **one Jira comment**, titled `✅
   research-loop - <short context>` (per the convention above),
   containing:
   - A one-paragraph summary (not the full Overview/AC/Scope write-up).
   - `[GitHub Issue](<url>)` — the GitHub Issue itself carries the full
     `### Overview` / `### Acceptance Criteria` / `### Scope` refined
     spec content as its own comment (see item 4 below) — `ticket-to-pr`
     reads the GitHub Issue as its real work order, not this Jira
     comment, once dev-loop migrates in Phase 2; until then, this Jira
     comment's link is what a human clicks through to review the real
     content.
```

- [ ] **Step 4: Update the bounce comment instructions**

Find the numbered item 3 (the one starting "**On a bounce**, write **one
Jira comment**, titled exactly `Ticket-Refine Bounce —
<failure_category>`, @-mentioning `jira.mentionAccountId`, containing the
same fixed Verdict/Summary/Needs-from-you header as before"). Replace it
with:

```markdown
3. **On a bounce**, write **one Jira comment**, titled `❌ research-loop -
   <short context>` (per the convention above — make the failure category
   obvious in plain language), containing the same fixed
   Verdict/Summary/Needs-from-you header as before, but with the free-form
   evidence section replaced by `[GitHub Issue](<url>)` carrying the full
   evidence — unless the bounce category is itself one of the four
   Jira-worthy kinds above (e.g. `spec_ambiguous` naming the specific
   ambiguous readings *is* the blocking-ambiguity content Jira is for) —
   in that case, the ambiguity/scope-call/confirmation-request content
   itself stays in this Jira comment directly, and only the *supporting*
   evidence (grounding detail, attack findings that fed the judgment)
   goes to the linked GitHub Issue.
```

- [ ] **Step 5: Update item 5 (re-pickup) and the GitHub Issue comment title**

Find item 5 ("**On re-pickup** (an existing `Refined Spec`/
`Ticket-Refine Bounce` Jira comment found, or an existing GitHub Issue
comment of the equivalent title found)") and item 4's GitHub Issue
comment title (`## Refined Spec — ready for ticket-to-pr`). Update both
to the new convention:

```markdown
4. **The GitHub Issue itself carries the full refined-ticket content** on
   a passing verdict — post the complete `### Overview` / `### Acceptance
   Criteria` / `### Scope` template (identical structure to the old
   full-detail Jira comment) as a GitHub Issue comment, titled in its own
   first line `## ✅ research-loop - <short context>` (GitHub has no
   comment-title field, so this is a markdown heading instead).
5. **On re-pickup** (an existing research-loop-titled Jira comment found,
   or an existing GitHub Issue comment of the equivalent title found —
   see "Setup: idempotent re-refinement" for the exact match rule): update
   that same comment/Issue-comment in place rather than posting a new one
   each cycle, on both sides independently.
```

- [ ] **Step 6: Update the "Bouncing (any step)" section's own bounce-comment instructions**

Find the section starting "2. Write **one Jira comment** (never the
description), titled exactly `Ticket-Refine Bounce — <failure_category>`
(e.g. `Ticket-Refine Bounce — blocked`)". Replace with:

```markdown
2. Write **one Jira comment** (never the description), titled `❌
   research-loop - <short context>` (per the convention above, e.g. `❌
   research-loop - blocked, needs a human decision`) — greppable by the
   leading icon + `research-loop -` prefix, no longer by the old fixed
   strings this replaces. Open the comment body with this fixed
   three-line header, then the evidence free-form below it (evidence
   genuinely varies by category — a `blocked` bounce and a
   `spec_contradicted` bounce don't look alike, and forcing them into one
   shape would lose signal):
   ```
   **Verdict:** bounced (`<failure_category>`)
   **Summary:** <one sentence — what's wrong, in plain language>
   **Needs from you:** <one sentence — the specific decision or action
     that unblocks this ticket, e.g. "approve the drafted split," "decide
     assertion strategy A or B," "confirm this should be filed against
     the Critics service">
   ---
   <free-form evidence: file paths, what was found vs. claimed, the
   specific ambiguous readings, the suggested split, drafted follow-up
   tickets, etc.>
   ```
   The free-form evidence below the fixed header lives in Jira only when
   the bounce category itself is Jira-worthy content per the routing rule
   (e.g. `spec_ambiguous` naming the ambiguous readings, `too_large`
   naming the scope call and its drafted split); otherwise this comment's
   evidence section is `[GitHub Issue](<url>)` carrying the full detail,
   per "Ticket content protocol" item 3 above.
   On re-pickup after a bounce, find and update this same comment (same
   title convention as a passing verdict) rather than posting a second
   one each cycle.
```

- [ ] **Step 7: Grep the file for any remaining old-title references and fix each**

Run: `grep -n "Refined Spec — ready for ticket-to-pr\|Ticket-Refine Bounce" .claude/skills/ticket-refine/SKILL.md`
Expected: no matches remain. Fix any that Steps 1-6 missed — read each
hit's surrounding paragraph and apply the same title-convention/
@-mention-removal/clean-link substitution used above.

- [ ] **Step 8: Update `docs/skills.md`**

Find wherever `docs/skills.md` documents the old comment title
convention or the @-mention requirement (it documents `ticket-refine`'s
behavior per this repo's own `CLAUDE.md` requirement to read it before
editing `SKILL.md`) and update it to match: the new `{✅|❌} research-loop
- <short context>` title convention, no @-mention, `[GitHub Issue](url)`
link format.

- [ ] **Step 9: Add a `CHANGELOG.md` entry**

```markdown
## 2026-09-17 — simplify Jira/GitHub comment templates: drop @-mention, terser title, clean issue link

Per docs/future-enhancements.md's "Simplify Jira/GitHub comment
templates" entry (decided 2026-09-16, not yet coded until now). Three
changes to `.claude/skills/ticket-refine/SKILL.md`'s "Ticket content
protocol": (1) dropped the mandatory `jira.mentionAccountId` @-mention
from every Jira comment — confirmed excessive in practice
(TARS-1462); the config field itself stays, unused, for now. (2) Replaced
the fixed titles (`Refined Spec — ready for ticket-to-pr`,
`Ticket-Refine Bounce — <category>`) with `{✅|❌} research-loop - <short
context>`, both outcomes. (3) Replaced the `Full Overview / Acceptance
Criteria (N ACs) / Scope write-up: <raw URL>` pointer with a clean
`[GitHub Issue](<url>)` markdown link. Also updated the "Setup: idempotent
re-refinement" section's re-pickup match rule (it used to grep for the old
fixed strings) to match on the new leading-icon + `research-loop -`
prefix instead. No transition period — old-titled comments on in-flight
tickets are simply no longer matched by re-pickup; this only means a
ticket with an old-titled comment gets a *new* comment on its next pass
rather than an update-in-place, which is harmless.
```

- [ ] **Step 10: Commit**

```bash
git add .claude/skills/ticket-refine/SKILL.md docs/skills.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(skill): simplify ticket-refine's Jira/GitHub comment templates

Drops the mandatory @-mention (confirmed excessive on TARS-1462),
replaces the fixed comment titles with "{check|x} research-loop - <short
context>", and replaces the old section-manifest pointer line with a
clean [GitHub Issue](url) markdown link. Also updates the re-pickup
match rule in "Setup: idempotent re-refinement" to match the new title
convention instead of grepping for the retired fixed strings. No
transition period for in-flight old-titled comments -- harmless, just
means one extra comment posted instead of an update-in-place.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: dev-loop — simplify the bounce comment template + adopt the same convention for the new GitHub write

**Files (dev-loop):**
- Modify: `src/loop-runner.ts` (`buildBounceCommentAdf`)
- Modify: `test/loop-runner.test.ts`
- Modify: `.claude/skills/ticket-to-pr/SKILL.md` (its own references to
  the Jira comment convention it reads, if any — mostly it reads
  research-loop's Jira comment as its work order, so check for stale
  references)
- Modify: `docs/skills.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `Verdict` (existing), `postGitHubDetail` pattern from Task 5
  (no new function — Task 5's GitHub writes already use plain strings,
  not titled comments, since GitHub Issue comments have no title field
  the way Jira comments do — this task only touches the **Jira** bounce
  comment's title/body, which is dev-loop's own `buildBounceCommentAdf`).
- Produces: `buildBounceCommentAdf(verdict: Verdict): Record<string,
  unknown>` (unchanged signature) now returns a comment with the `❌
  dev-loop - <short context>` convention baked into its own first
  paragraph (Jira comments don't have a separate title field either —
  `buildBounceCommentAdf`'s existing output is the *whole* comment body;
  the "title" convention for dev-loop's Jira comment is its own bold
  first line, matching how it already works today via the existing
  `Bounced (${verdict.failure_category}): ` bold prefix).

dev-loop's own bounce comment (`buildBounceCommentAdf`) never had a
`Ticket-Refine Bounce`-style *comment title* to begin with — Jira
comments don't have a title field; what research-loop calls its
"title convention" is really just the comment's own bold first line,
which is exactly what `buildBounceCommentAdf` already does today
(`Bounced (${verdict.failure_category}): `). Confirm this by re-reading
research-loop's Task 7 changes: the same is true there too — `"Refined
Spec — ready for ticket-to-pr"` was never a literal Jira comment-title
API field, it was the fixed leading text of the comment body, used as a
grep target for re-pickup. So this task's job is narrower than Task 7's:
adopt the same **grep-friendly leading-line convention**
(`{✅|❌} dev-loop - <short context>`) as dev-loop's own bounce comment's
first bold line, replacing the current `Bounced (${category}): ` prefix,
for consistency across both repos — per the spec's explicit instruction
that dev-loop's future GitHub-side writes (Task 5, already landed) and
Jira writes should use this convention "from day one," not invent a
different template later.

- [ ] **Step 1: Write the failing test for the new bounce comment convention**

In `test/loop-runner.test.ts`, find the existing `describe
("buildBounceCommentAdf", ...)` — if none exists yet, add one; check
first whether `buildBounceCommentAdf` is tested inline within the
`"a genuine bounce (no PR yet) posts the verdict's evidence..."` test
instead (per the grep in Task 5's planning, `buildBounceCommentAdf` is
exported from `loop-runner.ts` but may only be exercised indirectly).
Add a direct unit test:

```typescript
describe("buildBounceCommentAdf", () => {
  it("opens with the '{icon} dev-loop - <short context>' convention as its bold first line, not the old 'Bounced (<category>):' prefix", () => {
    const adf = buildBounceCommentAdf(
      makeVerdict({
        outcome: "bounced",
        failure_category: "spec_ambiguous",
        detail: "AC 3's assertion strategy is unspecified.",
      }),
    );

    const firstParagraph = (adf.content as Array<Record<string, unknown>>)[0];
    const firstTextNode = (firstParagraph.content as Array<Record<string, unknown>>)[0];
    expect(firstTextNode.text).toBe("❌ dev-loop - spec_ambiguous: ");
    expect((firstTextNode.marks as Array<{ type: string }>)[0].type).toBe("strong");
  });

  it("still includes the verdict's own detail text as the comment body, unchanged", () => {
    const adf = buildBounceCommentAdf(
      makeVerdict({ outcome: "bounced", failure_category: "blocked", detail: "Needs a human call." }),
    );
    const firstParagraph = (adf.content as Array<Record<string, unknown>>)[0];
    const detailTextNode = (firstParagraph.content as Array<Record<string, unknown>>)[1];
    expect(detailTextNode.text).toBe("Needs a human call.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- loop-runner`
Expected: FAIL — current output text is `Bounced (spec_ambiguous): `, not
`❌ dev-loop - spec_ambiguous: `.

- [ ] **Step 3: Update `buildBounceCommentAdf` in `src/loop-runner.ts`**

Replace:
```typescript
          { type: "text", text: `Bounced (${verdict.failure_category}): `, marks: [{ type: "strong" }] },
```
with:
```typescript
          { type: "text", text: `❌ dev-loop - ${verdict.failure_category}: `, marks: [{ type: "strong" }] },
```

Update the function's own doc comment (immediately above it) to note the
convention change — find the existing comment above `export function
buildBounceCommentAdf` and add one line: "Opens with the `{✅|❌}
dev-loop - <short context>` convention (matching research-loop's own
comment-title convention, per docs/future-enhancements.md's 'Simplify
Jira/GitHub comment templates' entry) as its bold first line, using
`failure_category` directly as the short-context text since it's already
a closed, human-readable-enough enum value for this repo's own bounce
comment (research-loop's own version writes a fuller plain-language
phrase; this repo's existing convention has always used the bare category
name and this change doesn't alter that, only the leading icon+repo-name
prefix)."

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- loop-runner`
Expected: PASS.

- [ ] **Step 5: Run the full suite to verify nothing else broke**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 6: Check `.claude/skills/ticket-to-pr/SKILL.md` for stale references**

Run: `grep -n "Bounced (\|Refined Spec\|Ticket-Refine Bounce" .claude/skills/ticket-to-pr/SKILL.md`

`ticket-to-pr` reads research-loop's `Refined Spec — ready for
ticket-to-pr` comment as its work order (Phase 0, step 2) — per Task 7,
research-loop no longer writes that exact title. Update every match:

Find "2. Find the comment titled exactly `Refined Spec — ready for
ticket-to-pr`. If no such comment exists, or it exists but doesn't follow
the definition-of-ready template..." and replace with:

```markdown
2. Find the ticket's research-loop-authored comment (title starts with
   `✅ research-loop -`, per research-loop's own comment convention — see
   its `docs/future-enhancements.md`'s "Simplify Jira/GitHub comment
   templates" entry). If no such comment exists, or it exists but doesn't
   follow the definition-of-ready template's `### Overview` / `###
   Acceptance Criteria` / `### Scope` structure (whether inline or via
   its `[GitHub Issue](url)` link) — this ticket should never have
   carried the `pipeline:dev` label — bounce immediately with
   `failure_category: "spec_ambiguous"` and detail noting the missing
   comment/sections. Do not attempt to proceed on an unreadied ticket.
```

Update every other reference to `Refined Spec — ready for ticket-to-pr`
in this file (per the earlier grep, lines ~17, 24, 27 and others) to say
"the research-loop comment" or "research-loop's `✅ research-loop -`
comment" instead of the retired fixed string, preserving the surrounding
sentence's meaning.

- [ ] **Step 7: Update `docs/skills.md`**

Find and update any reference to the old `Bounced (<category>):` prefix
or the old `Refined Spec` title research-loop used to write, matching the
new conventions from Task 7 and this task.

- [ ] **Step 8: Add a `CHANGELOG.md` entry**

```markdown
## 2026-09-17 — adopt the {icon} <repo> - <context> comment convention for the Jira bounce comment

buildBounceCommentAdf's bold first line changes from `Bounced
(<failure_category>):` to `❌ dev-loop - <failure_category>:`, matching
research-loop's own new comment-title convention (see that repo's
CHANGELOG.md, same date) rather than inventing a different template for
this repo's own GitHub write (Task 5, this session) to follow later.
Also updated ticket-to-pr/SKILL.md's Phase 0 intake step, which used to
look for research-loop's now-retired `Refined Spec — ready for
ticket-to-pr` exact title -- it now matches on the `✅ research-loop -`
prefix instead.
```

- [ ] **Step 9: Commit**

```bash
git add src/loop-runner.ts test/loop-runner.test.ts .claude/skills/ticket-to-pr/SKILL.md docs/skills.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat(loop-runner): adopt the {icon} <repo> - <context> comment convention

buildBounceCommentAdf's bold first line changes from "Bounced
(<category>):" to "❌ dev-loop - <category>:", matching research-loop's
new comment-title convention rather than inventing a separate template.
Also fixes ticket-to-pr/SKILL.md's Phase 0 intake, which looked for
research-loop's now-retired exact "Refined Spec — ready for
ticket-to-pr" title -- now matches the "✅ research-loop -" prefix.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final cross-repo verification pass

**Files:** none modified — verification only.

- [ ] **Step 1: Run both suites one more time**

```bash
cd /Users/206618626@bwt3.com/Desktop/Repos/research-loop && npm test
cd /Users/206618626@bwt3.com/Desktop/repos/dev-loop && npm test
```
Expected: both PASS, fully green.

- [ ] **Step 2: Re-check TARS-1462's own JQL match, confirming the bounce-loop fix holds for the real stuck ticket**

Via the Atlassian MCP `searchJiraIssuesUsingJql` tool, run the resolved
`pollJql.dev` JQL for webtarsthree (from Task 1) and confirm TARS-1462
(currently `Blocked`, carrying `pipeline:dev` + `pipeline:research`) is
**excluded** from the match. This is the concrete, real-world evidence
the fix actually resolves the incident that motivated this whole session
— not just that unit tests pass in isolation.

- [ ] **Step 3: Report a summary of what changed, cross-referencing runs.jsonl's TARS-1462 history as the before-state**

No commit for this task — purely a verification checkpoint before
reporting completion.
