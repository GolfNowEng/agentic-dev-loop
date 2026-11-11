# Jira Label Trigger — Phase 1 (GitHub Issue mirror + content routing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `jira.repoLabel` into research-loop's own `src/` (mirroring
dev-loop's already-landed pattern), then implement Phase 1 of the Jira
label-trigger / GitHub-Issues design: `ticket-refine` creates (idempotently)
one GitHub Issue per Jira ticket right after claim, a secret-redaction
`PreToolUse` hook guards every write to it, and the Jira-vs-GitHub content
routing rule is implemented in `SKILL.md` so Jira gets only the four
routing-rule-eligible comment types while everything else (recon/attack/
verify/working-notes/bounce evidence) goes to the GitHub Issue.

**Architecture:** `GitHubClient` is a new injected-dependency interface
(`src/github-client.ts`) mirroring `JiraClient`'s shape in
`src/jira-client.ts` — a `StubGitHubClient` that throws until wired, and a
`RealGitHubClient` implemented as thin wrappers around `gh` CLI invocations
(`gh issue list --search`, `gh issue create`), since the Atlassian-MCP
pattern (a named tool call) has no GitHub equivalent here and dev-loop's
own PR-creation code already establishes `gh` via `Bash`/`execFile` as this
pipeline family's real GitHub access pattern. `Config.github` is a new
per-project block (`repo`); `Config.jira` gains `repoLabel` (ported from
dev-loop) and `mentionAccountId`. `ticket-refine`'s `SKILL.md` gets a new
Step 0.5 ("Open/link the GitHub Issue") plus a rewritten "Ticket content
protocol" section implementing the routing rule, and a new
`.claude/hooks/block-github-secret-writes.sh` hook (adapting dev-loop's
`gh`-Bash-matcher pattern, not research-loop's own MCP-matcher pattern,
since the new write surface is `gh issue comment`/`gh issue create` via
`Bash`, exactly like dev-loop's PR surface) denies any secret-shaped write
before it reaches GitHub.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`, no build
step for running `src/`), Vitest, `gh` CLI (already on PATH, confirmed
`gh version 2.92.0`), bash hooks, `jq` (already on PATH, confirmed
`jq-1.7.1`).

**Spec:** `docs/future-enhancements.md`'s "## Jira label-based trigger
(both repos) + split Jira (PM) / GitHub Issues (research & dev)" section —
read that whole section before starting any task below. Phase 0 (label
trigger, both repos) is already shipped — see `CHANGELOG.md`'s "Jira label-
based trigger, Phase 0" entry (2026-09-16) in both repos. This plan
implements Phase 1 only (research-loop's half): GitHub Issue creation +
dual-write + the mandatory secret-redaction hook. Phase 2 (dev-loop reads
its work order from GitHub instead of the Jira comment) is out of scope
here entirely — do not touch dev-loop in this plan; its `jira.repoLabel`
port (item 1 below) is the one piece of dev-loop-mirrored work, and dev-
loop's own copy is already committed (commit `88252e0`, confirmed on disk
at `/Users/206618626@bwt3.com/Desktop/repos/dev-loop`).

## Global Constraints

- **TDD, strictly, for every `src/` change** — per `CLAUDE.md`: `npm test`
  must be green before and after every task that touches `src/`. Write the
  failing test first, confirm it fails, then implement.
- **Read `docs/skills.md` before editing `.claude/skills/ticket-refine/
  SKILL.md` or any file under `.claude/agents/`** — per `CLAUDE.md`. Already
  done for this plan; Task 5 below reflects it.
- **Read `docs/config.md` before touching `src/config.ts`, `Config` in
  `src/types.ts`, or any `pipeline.*.config.json`** — per `CLAUDE.md`.
  Already done for this plan.
- **Never write a raw secret/credential value anywhere** — `src/redact.ts`'s
  `containsSecret()`/`redactSecrets()` is the single source of truth; reuse
  it, never reimplement.
- **Never write an absolute filesystem path into a GitHub Issue** — same
  PII rule `SKILL.md`'s "Ticket content protocol" item 5 already applies to
  Jira comments; the routing rule moves content to GitHub, not the PII/
  secret rules governing it.
- **This skill never writes to the Jira description field**, and never
  will as a result of this plan — that protocol item is untouched.
- **Do not resolve `pipeline.catalog-ui-management.config.json` /
  `pipeline.catalog-ui-public.config.json`'s `"___"` placeholders** unless
  specifically doing so via a live Jira lookup — out of scope here, per the
  user's explicit instruction. This plan only adds new fields to those two
  files' existing shape (`repoLabel` is already present in them from a
  parallel session's work — verify, don't duplicate).
- **Closed `FailureCategory` enum is unchanged** — this plan adds no new
  values (`spec_ambiguous · spec_contradicted · blocked · too_large ·
  tests_flaky · env_setup · verify_rejected · subagent_stall ·
  merge_conflict · agent_error · killed_ceiling`).

---

## Task 0: Confirm `jira.repoLabel` is not already in research-loop's `src/`

**Files:** none modified — this is a verification-only task, since a
parallel session's message claims dev-loop already has this landed
(commit `88252e0`) and research-loop's own two new project config files
(`pipeline.catalog-ui-management.config.json`,
`pipeline.catalog-ui-public.config.json`) already contain a `repoLabel`
field on disk, but `src/types.ts`/`src/jql.ts`/`src/config.ts` do not yet
read or validate it.

- [ ] **Step 1: Confirm the gap**

Run:
```bash
grep -n "repoLabel" src/types.ts src/jql.ts src/config.ts
```
Expected: no output (confirms the port described in Task 1 is still
needed). If this instead prints matches, STOP — someone already ported it;
skip Task 1 entirely and move to Task 2, re-reading whatever is on disk
first.

- [ ] **Step 2: Confirm the two project config files already carry `repoLabel`**

Run:
```bash
grep -n "repoLabel" pipeline.catalog-ui-management.config.json pipeline.catalog-ui-public.config.json pipeline.webtarsthree.config.json
```
Expected: matches in the two `catalog-ui-*` files (`"repo:catalog-ui-
management"` / `"repo:catalog-ui-public"`), no match in
`pipeline.webtarsthree.config.json` yet (Task 1 adds it there, mirroring
dev-loop's own webtarsthree config which now has
`"repoLabel": "repo:webtarsthree"`).

No commit for this task — it's pure verification, feeding Task 1.

---

## Task 1: Port `jira.repoLabel` into research-loop's `src/`

**Files:**
- Modify: `src/types.ts` (add `repoLabel` to the `jira` block of `Config`)
- Modify: `src/jql.ts` (`buildRefineJql`/`buildDevJql` interpolate
  `{repoLabel}`)
- Modify: `src/config.ts` (`PLACEHOLDER_PATHS` gains `jira.repoLabel`)
- Modify: `test/jql.test.ts`, `test/config.test.ts`,
  `test/ceilings.test.ts`, `test/jira-client.test.ts`,
  `test/loop-runner.test.ts` (every `makeConfig()` helper needs a
  `repoLabel` field, or `Config` objects built inline stop type-checking)
- Modify: `pipeline.webtarsthree.config.json` (add `"repoLabel":
  "repo:webtarsthree"`, matching dev-loop's own webtarsthree config)
- Modify: `docs/config.md` (document the new field — mirror dev-loop's
  `docs/config.md` wording, adapted for research-loop's own poll structure)
- Modify: `CHANGELOG.md` (new entry, same shape as dev-loop's own
  "`jira.repoLabel`: disambiguate repos that share one Jira project" entry)

**Interfaces:**
- Consumes: nothing new from other tasks — this is the first task.
- Produces: `Config.jira.repoLabel: string`; `buildRefineJql(config:
  Config): string` and `buildDevJql(config: Config): string` (unchanged
  signatures) now also substitute `{repoLabel}` if the template contains
  it; `findPlaceholders(config: Config): string[]` includes
  `"jira.repoLabel"` when unset. Later tasks in this plan do not depend on
  `repoLabel` directly (Phase 1's GitHub work is Jira-label-agnostic), but
  this must land first since it's this session's first checked scope item
  and touches the same `Config` shape Task 2 extends next.

This is a straightforward, low-risk port of code already TDD'd and
committed in the sibling repo (`/Users/206618626@bwt3.com/Desktop/repos/
dev-loop`, commit `88252e0`) — mirror it exactly rather than redesigning,
adjusting only for research-loop's own poll structure (research-loop's
`pollJql.refine` has no `{assignee}` placeholder the way dev-loop's
`pollJql.dev` does — don't introduce one).

- [ ] **Step 1: Write the failing test for `buildRefineJql`/`buildDevJql` interpolating `{repoLabel}`**

In `test/jql.test.ts`, replace the whole file with:

```typescript
import { describe, it, expect } from "vitest";
import { buildRefineJql, buildDevJql } from "../src/jql.ts";
import type { Config } from "../src/types.ts";

function makeConfig(): Config {
  return {
    jira: {
      triggerLabel: "pipeline:research",
      handoffLabel: "pipeline:dev",
      repoLabel: "repo:webtarsthree",
      claimStatus: { from: "Backlog", to: "In Progress" },
      pollJql: {
        refine: 'labels = "{label}" AND labels = "{repoLabel}" AND status = "Backlog" ORDER BY created ASC',
        dev: 'labels = "{label}" AND labels = "{repoLabel}" ORDER BY created ASC',
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

  it("substitutes repoLabel into the refine template, disambiguating repos that share one Jira project", () => {
    const jql = buildRefineJql(makeConfig());
    expect(jql).toContain("repo:webtarsthree");
    expect(jql).not.toContain("{repoLabel}");
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

  it("substitutes repoLabel into the dev template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("repo:webtarsthree");
    expect(jql).not.toContain("{repoLabel}");
  });

  it("preserves the ORDER BY oldest-first clause from the template", () => {
    const jql = buildDevJql(makeConfig());
    expect(jql).toContain("ORDER BY created ASC");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- jql`
Expected: FAIL — `makeConfig()`'s object literal is missing `repoLabel`
(TypeScript error under vitest's esbuild transform, or if that's not
caught at test time, the two new "substitutes repoLabel" assertions fail
because `buildRefineJql`/`buildDevJql` don't know about `{repoLabel}` yet
and the raw placeholder string leaks through).

- [ ] **Step 3: Add `repoLabel` to `Config` in `src/types.ts`**

In `src/types.ts`, inside the `jira` block of the `Config` interface,
immediately after the `handoffLabel` field's closing (before
`claimStatus`), add:

```typescript
    /**
     * A second, always-paired label naming which repo a ticket belongs to
     * -- e.g. "repo:catalog-ui-management". Needed because more than one
     * target repo can share the same Jira project (catalog-ui-management
     * and catalog-ui-public both file into project MC): the stage label
     * alone (triggerLabel/handoffLabel) can't tell those two apart, so
     * pollJql ANDs this label in too. Unlike triggerLabel/handoffLabel,
     * repoLabel never changes across a ticket's lifecycle -- it identifies
     * the repo, not the pipeline stage. Ported from dev-loop's identical
     * field (see dev-loop's CHANGELOG.md, 2026-09-16).
     */
    repoLabel: string;
```

- [ ] **Step 4: Update `buildRefineJql`/`buildDevJql` in `src/jql.ts`**

Replace the two functions' bodies:

```typescript
export function buildRefineJql(config: Config): string {
  return config.jira.pollJql.refine
    .replace("{label}", config.jira.triggerLabel)
    .replace("{repoLabel}", config.jira.repoLabel);
}
```

```typescript
export function buildDevJql(config: Config): string {
  return config.jira.pollJql.dev
    .replace("{label}", config.jira.handoffLabel)
    .replace("{repoLabel}", config.jira.repoLabel);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- jql`
Expected: PASS (7 tests).

- [ ] **Step 6: Write the failing test for `findPlaceholders` detecting `jira.repoLabel`**

In `test/config.test.ts`, update `makeConfig()`'s `jira` block to include
`repoLabel: "repo:webtarsthree"`, and add this test inside the
`findPlaceholders / assertNoPlaceholders` describe block, right after the
existing "lists every field still set to the placeholder value" test:

```typescript
  it("lists jira.repoLabel when it's still set to the placeholder value", () => {
    const config = makeConfig({
      jira: { ...makeConfig().jira, repoLabel: "___" },
    });
    const missing = findPlaceholders(config);
    expect(missing).toContain("jira.repoLabel");
  });
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL — `findPlaceholders` doesn't check `jira.repoLabel` yet, so
`missing` won't contain it.

- [ ] **Step 8: Add `jira.repoLabel` to `PLACEHOLDER_PATHS` in `src/config.ts`**

In `src/config.ts`, in the `PLACEHOLDER_PATHS` array, immediately after the
`["jira.handoffLabel", ...]` entry, add:

```typescript
  ["jira.repoLabel", (c) => c.jira.repoLabel],
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 10: Fix every other `Config`-literal test helper so the whole suite type-checks and passes**

`repoLabel` is a required field on `Config["jira"]`, so every other test
file building a `Config` object inline now needs it added to its own
`makeConfig()`/`CREDENTIALS`-adjacent helper. Add `repoLabel:
"repo:webtarsthree"` (or `"repo:org-repo"` for the more generic
`test/loop-runner.test.ts`/`test/ceilings.test.ts`/
`test/jira-client.test.ts` helpers that use `targetRepo: {
url: "git@github.com:org/repo.git", ... }`, matching that file's existing
naming style) to the `jira` block in:
- `test/ceilings.test.ts`'s `makeConfig()`
- `test/jira-client.test.ts`'s `makeConfig()`
- `test/loop-runner.test.ts`'s `makeConfig()`

- [ ] **Step 11: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS, all test files green (should be 152 + the 2 new tests from
Step 1/6 = 154, plus whatever Step 10 didn't add new tests for, just fixed
compilation).

- [ ] **Step 12: Add `repoLabel` to `pipeline.webtarsthree.config.json`**

Update the file's `jira` block to add, right after `"handoffLabel":
"pipeline:dev",`:

```json
    "repoLabel": "repo:webtarsthree",
```

- [ ] **Step 13: Update `docs/config.md`**

Add a new bullet to the "## Shape" list, right after the
`jira.triggerLabel` / `handoffLabel` bullet, mirroring dev-loop's own
`docs/config.md` wording (adapted — research-loop's poll only ever uses
`pollJql.refine` in production, not `.dev`):

```markdown
- `jira.repoLabel` — a second, always-paired label naming which repo a
  ticket belongs to (e.g. `"repo:catalog-ui-management"`), ANDed into both
  `pollJql` templates alongside the stage label. Needed because more than
  one target repo can share a single Jira project — `catalog-ui-management`
  and `catalog-ui-public` both file into project `MC` — so the stage label
  alone (`triggerLabel`/`handoffLabel`) can't tell which repo a given
  ticket actually belongs to. Unlike `triggerLabel`/`handoffLabel`,
  `repoLabel` never changes across a ticket's lifecycle. A project with
  only one target repo (e.g. `webtarsthree`/`TARS`) doesn't strictly need
  this for disambiguation, but every `pipeline.<project>.config.json` sets
  it anyway for a uniform scheme across projects. Ported from dev-loop's
  identical field (see dev-loop's `CHANGELOG.md`, 2026-09-16).
```

Also update the "`jira.pollJql.{refine,dev}`" bullet immediately below it
to say `{label}` and `{repoLabel}` placeholders (currently says just
`{label}`), and update the "## Appendix A" section's "confirming the two
pipeline label strings" phrase to "confirming the three pipeline label
strings (`triggerLabel`, `handoffLabel`, `repoLabel`)".

- [ ] **Step 14: Add a `CHANGELOG.md` entry**

Add a new entry at the top of `CHANGELOG.md` (after the header, before the
existing newest entry), dated `2026-09-16`, titled `## 2026-09-16 —
jira.repoLabel: disambiguate repos that share one Jira project`, body
modeled on dev-loop's own entry of the same name (adjust wording for
research-loop's context — this repo's poll only ever uses
`pollJql.refine`).

- [ ] **Step 15: Commit**

```bash
git add src/types.ts src/jql.ts src/config.ts test/jql.test.ts test/config.test.ts test/ceilings.test.ts test/jira-client.test.ts test/loop-runner.test.ts pipeline.webtarsthree.config.json docs/config.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat(config): port jira.repoLabel from dev-loop to disambiguate repos sharing one Jira project

catalog-ui-management and catalog-ui-public both file into Jira project MC,
so the stage label alone can't tell research-loop which repo a ticket
belongs to. Mirrors dev-loop's already-committed identical field
(dev-loop commit 88252e0) verbatim, adapted only for research-loop's own
poll structure (no {assignee} placeholder in pollJql.refine).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `Config.github` block + `Config.jira.mentionAccountId`

**Files:**
- Modify: `src/types.ts` (add `github: { repo: string }` to `Config`; add
  `jira.mentionAccountId: string`)
- Modify: `src/config.ts` (`PLACEHOLDER_PATHS` gains `github.repo` and
  `jira.mentionAccountId`)
- Modify: `test/config.test.ts`, `test/ceilings.test.ts`,
  `test/jira-client.test.ts`, `test/loop-runner.test.ts` (every
  `makeConfig()` needs `github.repo` and `jira.mentionAccountId`)
- Modify: `pipeline.webtarsthree.config.json`,
  `pipeline.catalog-ui-management.config.json`,
  `pipeline.catalog-ui-public.config.json` (add `github.repo` — real values
  below; add `jira.mentionAccountId` as literal `"___"`, since it's a real
  per-project Jira account ID this plan cannot look up)
- Modify: `docs/config.md` (document both new fields)

**Interfaces:**
- Consumes: `Config` shape from Task 1 (already has `repoLabel`).
- Produces: `Config.github.repo: string` (e.g. `"fandango/webtarsthree"`,
  `<owner>/<repo>` shorthand `gh` itself accepts via `--repo`) and
  `Config.jira.mentionAccountId: string` — both consumed by Task 3's
  `GitHubClient`/`RealGitHubClient` (github.repo) and Task 5's `SKILL.md`
  routing-rule changes (mentionAccountId, for the @-mention requirement).

Per the design doc's config sketch, `github.repo` is per-project (one
target repo per project config file, same granularity as `targetRepo.url`)
— derive its value from each project's existing `targetRepo.url` rather
than inventing a new source of truth: `webtarsthree` →
`git@github.com:fandango/webtarsthree.git` → `"fandango/webtarsthree"`;
`catalog-ui-management` → `git@github.com:fandango/catalog-ui-management.git`
→ `"fandango/catalog-ui-management"`; `catalog-ui-public` →
`git@github.com:fandango/catalog-ui-public.git` → `"fandango/catalog-ui-public"`.

`jira.mentionAccountId` cannot be filled with a real value in this plan
(no live Jira lookup is in scope, matching this session's explicit
instruction to leave the two `catalog-ui-*` configs' unverified placeholders
alone) — set it to the literal placeholder `"___"` in all three project
config files, consistent with how every other real-Jira-value field starts.
This does mean `assertNoPlaceholders` will now report
`jira.mentionAccountId` missing for `pipeline.webtarsthree.config.json`
too, even though that file's other fields are filled in — that's correct
and expected: this genuinely is an unfilled real Jira value (Justin's own
Jira accountId), not a stand-in for something else.

- [ ] **Step 1: Write the failing test for `findPlaceholders` covering the two new fields**

In `test/config.test.ts`, update `makeConfig()` to add, inside the `jira`
block: `mentionAccountId: "user-123"`, and at the top level (as a sibling
of `jira`/`ceilings`/`autoPromoteLabel`/`targetRepo`):

```typescript
    github: { repo: "fandango/webtarsthree" },
```

Then add two new tests inside the `findPlaceholders / assertNoPlaceholders`
describe block:

```typescript
  it("lists jira.mentionAccountId when it's still set to the placeholder value", () => {
    const config = makeConfig({
      jira: { ...makeConfig().jira, mentionAccountId: "___" },
    });
    const missing = findPlaceholders(config);
    expect(missing).toContain("jira.mentionAccountId");
  });

  it("lists github.repo when it's still set to the placeholder value", () => {
    const config = makeConfig({ github: { repo: "___" } });
    const missing = findPlaceholders(config);
    expect(missing).toContain("github.repo");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL — `Config` doesn't have a `github` field yet (compile
error) and `findPlaceholders` doesn't check either new path.

- [ ] **Step 3: Add the two fields to `Config` in `src/types.ts`**

Inside the `jira` block, immediately after the new `repoLabel` field from
Task 1, add:

```typescript
    /**
     * Jira accountId to @-mention in every Jira-worthy comment this repo
     * writes (per the routing rule -- see SKILL.md's "Ticket content
     * protocol"). Sourced the same way JIRA_ASSIGNEE_ACCOUNT_ID/
     * assigneeAccountIdFromEnv already works in jira-client.ts, but this
     * is a config field, not an env var, since the person to mention is a
     * per-project decision (who owns this project's tickets), not a
     * per-machine/per-runner-identity setting.
     */
    mentionAccountId: string;
```

Then, as a new top-level sibling of `jira` in the `Config` interface (after
the closing `};` of the `jira` block, before `ceilings`), add:

```typescript
  /**
   * Phase 1 of the Jira-label-trigger design (docs/future-enhancements.md):
   * this pipeline mirrors every claimed ticket into a GitHub Issue and
   * posts recon/attack/verify/working-note content there instead of Jira,
   * per the routing rule in SKILL.md. One target repo per project config,
   * same granularity as targetRepo -- derived from the same codebase this
   * skill grounds tickets against, not a separate system.
   */
  github: {
    /** "owner/repo" shorthand, e.g. "fandango/webtarsthree" -- passed
     * directly to `gh`'s own --repo flag, which accepts this exact shape. */
    repo: string;
  };
```

- [ ] **Step 4: Add both new paths to `PLACEHOLDER_PATHS` in `src/config.ts`**

Add, after the `jira.repoLabel` entry from Task 1:

```typescript
  ["jira.mentionAccountId", (c) => c.jira.mentionAccountId],
```

And after the `targetRepo.defaultBranch` entry (the last one in the
array):

```typescript
  ["github.repo", (c) => c.github.repo],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 6: Fix every other `Config`-literal test helper**

Add `mentionAccountId: "user-123"` to the `jira` block and a top-level
`github: { repo: "fandango/webtarsthree" }` (or the generic
`"org/repo"`-style value matching that file's existing `targetRepo`
convention) to:
- `test/ceilings.test.ts`'s `makeConfig()`
- `test/jira-client.test.ts`'s `makeConfig()`
- `test/loop-runner.test.ts`'s `makeConfig()`

- [ ] **Step 7: Run the full suite to verify it passes**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 8: Update the three project config files**

In `pipeline.webtarsthree.config.json`, add to the `jira` block (after
`repoLabel`): `"mentionAccountId": "___"`. Add as a new top-level key
(after `targetRepo`): `"github": { "repo": "fandango/webtarsthree" }`.

In `pipeline.catalog-ui-management.config.json`, add to the `jira` block:
`"mentionAccountId": "___"`. Add: `"github": { "repo":
"fandango/catalog-ui-management" }`.

In `pipeline.catalog-ui-public.config.json`, add to the `jira` block:
`"mentionAccountId": "___"`. Add: `"github": { "repo":
"fandango/catalog-ui-public" }`.

- [ ] **Step 9: Update `docs/config.md`**

Add two new bullets to "## Shape": one for `jira.mentionAccountId`
(explain the @-mention routing-rule requirement and that this is
per-project config, not the `JIRA_ASSIGNEE_ACCOUNT_ID` env var, even
though both are Jira accountIds), and one for `github.repo` (explain
Phase 1, one target repo per project, `owner/repo` shorthand passed
straight to `gh --repo`). Also update "## Appendix A" to mention filling
in `mentionAccountId` alongside the pipeline label strings, and add a
one-line note to "## Adding a new project" that a new project also needs
its own `github.repo` value.

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts test/ceilings.test.ts test/jira-client.test.ts test/loop-runner.test.ts pipeline.webtarsthree.config.json pipeline.catalog-ui-management.config.json pipeline.catalog-ui-public.config.json docs/config.md
git commit -m "$(cat <<'EOF'
feat(config): add Config.github.repo and jira.mentionAccountId for Phase 1

Per docs/future-enhancements.md's Jira label-trigger design's config
sketch: github.repo is the per-project GitHub Issue mirror target
(one per project, derived from each config's existing targetRepo.url);
mentionAccountId is the Jira accountId to @-mention in every Jira-worthy
comment per the new routing rule. Real mentionAccountId values left as
"___" placeholders -- filling them needs a live Jira accountId lookup,
out of scope for this change per the user's explicit instruction not to
resolve the two catalog-ui-* configs' unverified placeholders.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `GitHubClient` interface + `RealGitHubClient` (gh-CLI-backed)

**Files:**
- Create: `src/github-client.ts`
- Test: `test/github-client.test.ts`

**Interfaces:**
- Consumes: `Config.github.repo` (Task 2).
- Produces: `GitHubIssue { number: number; url: string }`;
  `GitHubClient` interface with `findIssueByJiraKey(jiraKey: string):
  Promise<GitHubIssue | null>` and `createIssue(params: { title: string;
  body: string; jiraKey: string }): Promise<GitHubIssue>`; `StubGitHub
  Client` (throws, mirrors `StubJiraClient`); `RealGitHubClient`
  (constructor takes `{ repo: string }`, shells out to `gh` via an
  injected `execFn` for testability). Task 4 (idempotent Issue creation in
  `runLoopIteration` or a new helper) and Task 5 (`SKILL.md`'s Step 0.5)
  both depend on this exact interface shape.

Mirror `JiraClient`'s interface style (see `src/jira-client.ts:24-56`):
narrow, purpose-built methods, never generic "call the API" passthroughs.
Idempotency (does an Issue for this Jira key already exist before
creating) is a first-class method, not a caller-side convention, so every
caller gets it for free and there's exactly one place that defines "how do
we find an existing mirror Issue" (a title-prefix search, since GitHub
Issues has no custom-field equivalent to stash a Jira key in structured
metadata the way this pipeline might use a Jira label): search open+closed
issues whose title starts with `"<JIRA-KEY>: "` (the Title convention the
design doc specifies — `<JIRA-KEY>: <ticket summary>`).

Unlike `JiraClient`, this shells out to the `gh` CLI (already the
established pattern in this pipeline family — see dev-loop's PR-creation
code) rather than making direct REST calls, since `gh` already handles
GitHub auth (`gh auth login`, already required by any human using this
pipeline's push-branch/PR workflows) and JSON output formatting
(`--json`), avoiding a second GitHub REST client/auth scheme in this repo
purely for issue creation.

- [ ] **Step 1: Write the failing test for the interface shape and `RealGitHubClient.findIssueByJiraKey`**

Create `test/github-client.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { RealGitHubClient, StubGitHubClient } from "../src/github-client.ts";

describe("StubGitHubClient", () => {
  it("throws on every method until wired with a real config", async () => {
    const client = new StubGitHubClient();
    await expect(client.findIssueByJiraKey("PROJ-1")).rejects.toThrow(/not configured/);
    await expect(
      client.createIssue({ title: "PROJ-1: x", body: "y", jiraKey: "PROJ-1" }),
    ).rejects.toThrow(/not configured/);
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

  it("createIssue passes title/body and repo to gh issue create, returns the parsed issue", async () => {
    const execFn = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "create") {
        return "https://github.com/org/repo/issues/43\n";
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    const issue = await client.createIssue({
      title: "PROJ-1: fix the thing",
      body: "## Overview\n...",
      jiraKey: "PROJ-1",
    });

    expect(issue).toEqual({ number: 43, url: "https://github.com/org/repo/issues/43" });
    expect(execFn).toHaveBeenCalledWith([
      "issue",
      "create",
      "--repo",
      "org/repo",
      "--title",
      "PROJ-1: fix the thing",
      "--body",
      "## Overview\n...",
    ]);
  });

  it("createIssue throws a descriptive error when gh itself fails", async () => {
    const execFn = vi.fn(async () => {
      throw new Error("gh: authentication required");
    });
    const client = new RealGitHubClient({ repo: "org/repo" }, execFn);

    await expect(
      client.createIssue({ title: "PROJ-1: x", body: "y", jiraKey: "PROJ-1" }),
    ).rejects.toThrow(/authentication required/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- github-client`
Expected: FAIL — `src/github-client.ts` does not exist yet.

- [ ] **Step 3: Implement `src/github-client.ts`**

```typescript
/**
 * GitHub access boundary for research-loop's Phase 1 GitHub-Issue mirror
 * (docs/future-enhancements.md's Jira label-trigger design). Mirrors
 * JiraClient's interface style (src/jira-client.ts) -- narrow, purpose-
 * built methods, never a generic "call gh" passthrough. Shells out to the
 * `gh` CLI (already this pipeline family's established GitHub-auth
 * pattern -- see dev-loop's PR-creation code) rather than a direct REST
 * client, so this repo needs no second GitHub auth scheme.
 */

/** Minimal shape of a GitHub Issue as this pipeline needs it. */
export interface GitHubIssue {
  number: number;
  url: string;
}

export interface GitHubClient {
  /**
   * Find an existing mirror Issue for the given Jira ticket key, by
   * searching for an issue whose title starts with "<jiraKey>: " (this
   * repo's own title convention -- see createIssue). Returns null if none
   * exists. Callers use this for idempotency: check before creating, to
   * avoid a duplicate Issue from a poll-loop race (the same class of race
   * the postRunDelaySec fix addressed for Jira polling).
   */
  findIssueByJiraKey(jiraKey: string): Promise<GitHubIssue | null>;

  /**
   * Create a new mirror Issue. Callers are responsible for calling
   * findIssueByJiraKey first and skipping this call if one already
   * exists -- this method itself does not check.
   */
  createIssue(params: { title: string; body: string; jiraKey: string }): Promise<GitHubIssue>;
}

const UNCONFIGURED_MESSAGE = (method: string): string =>
  `GitHubClient.${method}: GitHub repo target is not configured. ` +
  `Config.github.repo (pipeline.<project>.config.json) is still unfilled -- ` +
  `this needs a real "owner/repo" value before any GitHub call can be made.`;

/**
 * Placeholder GitHubClient. Every method throws until Config.github.repo
 * is filled in and a real client is wired in. Exists so callers have
 * something concrete to run against outside of tests without silently
 * pretending to talk to GitHub.
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
}

/** Stand-in for spawning `gh <args>` and returning its stdout. Injected so tests never shell out for real. */
export type ExecGhFn = (args: string[]) => Promise<string>;

interface GhIssueListEntry {
  number: number;
  url: string;
}

/**
 * gh-CLI-backed GitHubClient. `execFn` defaults to a real `gh` spawn via
 * node:child_process's execFile, promisified -- injectable for tests.
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
    return { number: Number(match[1]), url };
  }
}

/**
 * Real `execFn` for production wiring: spawns `gh <args>` via execFile,
 * returning stdout. Throws with gh's own stderr included on a non-zero
 * exit, so a caller sees the real reason (e.g. "gh: authentication
 * required") rather than a bare exit-code message.
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
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full suite to verify nothing else broke**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 6: Commit**

```bash
git add src/github-client.ts test/github-client.test.ts
git commit -m "$(cat <<'EOF'
feat(github-client): add GitHubClient interface + gh-CLI-backed RealGitHubClient

Mirrors JiraClient's injected-interface style (src/jira-client.ts) for
Phase 1's GitHub Issue mirror. findIssueByJiraKey searches by title
prefix ("<jiraKey>: ") for idempotency -- callers check before creating,
avoiding a duplicate Issue from a poll-loop race. Shells out to the `gh`
CLI (this pipeline family's established GitHub-auth pattern, per
dev-loop's own PR-creation code) rather than a second REST client.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `GitHubClient` into `main.ts`'s composition root (idempotent Issue creation before the skill runs)

**Files:**
- Modify: `src/main.ts`
- No new test file — `main.ts` is this repo's explicitly untested
  composition root (see its own header comment); this task's correctness
  is covered by Task 3's already-tested `GitHubClient` methods plus manual
  verification in Task 7.

**Interfaces:**
- Consumes: `RealGitHubClient`/`StubGitHubClient`/`realExecGh` (Task 3),
  `Config.github.repo` (Task 2).
- Produces: nothing new for later tasks — this is where Task 3's client
  actually gets exercised against real GitHub, right after a ticket is
  claimed, before `runSkill` is invoked. `SKILL.md` (Task 5) documents this
  as happening "outside the skill, by the loop runner" — a deliberate
  design decision (see Step 1 below) worth recording explicitly since the
  design doc left "exact step" as unscoped.

**Design decision this task makes** (the doc's own "Not yet scoped" list
names "exact step in ticket-refine where GitHub Issue creation happens" as
open — resolve it here, don't leave it ambiguous):

Create the GitHub Issue from `main.ts`'s `runSkill` closure, immediately
after `jiraClient.claim()` succeeds and before spawning `claude -p` for
`ticket-refine` itself — **not** from inside the skill's own Step 0/intake
turn. Rationale: (a) idempotency and GitHub auth are infrastructure
concerns the loop runner already owns for Jira (claim, assign) — the skill
itself never touches Jira/GitHub write APIs directly today except via
Atlassian MCP tool calls, and giving it a second, differently-shaped write
surface (a raw `gh` Bash call) inside its own reasoning turn adds failure
modes (a botched `gh` invocation mid-skill-run) this task can avoid
entirely by doing it once, deterministically, in already-tested
infrastructure code; (b) the skill needs the Issue's URL before it can
cross-link to it in its own comments — creating it before the skill starts
means the URL is simply available as a fact, not something the skill has
to create-then-remember mid-run; (c) this exactly matches how `assignTicket`
already works (loop-runner-owned, "right after claim," never something the
skill does itself). Record this decision in `docs/skills.md` (Task 5) and
`CHANGELOG.md` (Task 8), since the design doc explicitly flagged it as an
open call this plan needs to make and document.

- [ ] **Step 1: Add `RealGitHubClient` construction and the pre-run Issue-creation call to `main.ts`**

In `src/main.ts`, add the import (alongside the existing `jira-client.ts`
import):

```typescript
import { RealGitHubClient, realExecGh } from "./github-client.ts";
```

After the existing `const jiraClient = new RealJiraClient(credentials,
config);` line, add:

```typescript
const githubClient = new RealGitHubClient(config.github, realExecGh());
```

Inside the `runSkill` closure, immediately after the existing
`log(\`[${SKILL_NAME}] claimed ${ticket.key}, running...\`);` line and
before `const tail = startProgressTail(...)`, add:

```typescript
    try {
      const existingIssue = await githubClient.findIssueByJiraKey(ticket.key);
      if (existingIssue) {
        log(
          `[${SKILL_NAME}] ${ticket.key}: GitHub Issue already exists (${existingIssue.url}), skipping creation`,
        );
      } else {
        const issue = await githubClient.createIssue({
          title: `${ticket.key}: (refinement in progress)`,
          body: `Mirror of Jira ticket ${ticket.key}. ticket-refine is running -- this Issue will be updated with recon/attack/verify findings per the routing rule as the run progresses.`,
          jiraKey: ticket.key,
        });
        log(`[${SKILL_NAME}] ${ticket.key}: created GitHub Issue ${issue.url}`);
      }
    } catch (err) {
      // A GitHub Issue creation failure must never block the actual
      // ticket-refine run -- same "never throw out of runSkill" contract
      // every other I/O boundary in this function already follows (spawn
      // failure, raw-usage persistence). Log it and let ticket-refine run
      // without a mirror Issue this time; a human can create one by hand,
      // or a future run will retry (findIssueByJiraKey will find nothing
      // and try again).
      const message = err instanceof Error ? err.message : String(err);
      logError(`[${SKILL_NAME}] ${ticket.key}: GitHub Issue creation/lookup failed: ${message}`);
    }
```

Note: the Issue's title is intentionally a placeholder
(`"(refinement in progress)"`) at creation time — the real ticket summary
is not yet loaded into this composition-root code (it lives in Jira, read
by the skill itself via `getJiraIssue`, not by `main.ts`). Task 5's
`SKILL.md` changes have the skill itself rename the Issue (via `gh issue
edit --title`, reusing the already-open-Issue idempotency path) once it
has read the ticket's real summary during Step 1 (Interpret) — see Task 5.

- [ ] **Step 2: Manually verify `main.ts` still parses/type-checks**

Run: `npx tsc --noEmit`
Expected: no new errors (this repo's `tsconfig.json` has `"include":
["src"]`, so this covers `main.ts`).

- [ ] **Step 3: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: PASS, all green (no test file covers `main.ts` directly, so this
just confirms Tasks 1-3's changes didn't regress).

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "$(cat <<'EOF'
feat(main): create/find the mirror GitHub Issue right after claim, before ticket-refine runs

Design decision (docs/future-enhancements.md left this unscoped): Issue
creation lives in main.ts's composition root, not inside ticket-refine's
own Step 0/intake turn -- same place assignTicket already lives, for the
same reason (infrastructure concern the loop runner already owns, not a
skill-reasoning step). Idempotent via GitHubClient.findIssueByJiraKey;
a creation/lookup failure is logged and never blocks the run, matching
every other I/O boundary in runSkill's existing never-throw contract.
Title is a placeholder at creation time (main.ts doesn't have the real
ticket summary) -- SKILL.md's Step 0.5 renames it once the skill has read
the real summary.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Secret-redaction hook for the new GitHub write surface

**Files:**
- Create: `.claude/hooks/block-github-secret-writes.sh`
- Modify: `.claude/settings.json` (register the new hook's `PreToolUse`
  matcher)
- Test: `test/hooks/block-github-secret-writes.test.mjs`

**Interfaces:**
- Consumes: `containsSecret()` from `src/redact.ts` (unchanged, already
  exists), `scripts/check-secret-in-tool-input.ts`'s existing pattern.
- Produces: a hook that denies (exit 2) any `Bash` call recognized as a
  `gh issue create`/`gh issue edit`/`gh issue comment` invocation whose
  content is secret-shaped. Task 6 (`SKILL.md`) references this hook by
  name as the enforcement mechanism behind the new "never paste a secret
  into the GitHub Issue" rule, the same way the existing Jira rule
  references `block-secret-comments.sh`.

Per the design doc: **this is a mandatory launch blocker for Phase 1, not
a fast-follow** — it must exist before any GitHub-Issue-writing code in
Task 4/5 ships to a real ticket. (Task 4 above is already written to only
create a placeholder title/body with no ticket content in it, so it is
safe on its own — but Task 5's `SKILL.md` changes have the skill itself
write real recon/attack/verify/working-note content to the Issue via `gh
issue comment`/`gh issue edit`, which is the surface this hook must guard
before that lands.) Do Task 5 (this hook) before Task 6 (`SKILL.md`
content-routing changes) for exactly this reason — the guard must exist
before the content it guards.

This adapts dev-loop's `.claude/hooks/block-secret-comments.sh` (its
`gh`-Bash-matcher variant, not research-loop's own MCP-tool-matcher
variant) since the new write surface here is also a raw `gh` Bash
invocation, not a named MCP tool — same reasoning dev-loop's own hook
comment already documents. Reuses `scripts/check-secret-in-tool-input.ts`
(already exists in research-loop, currently scoped to Atlassian MCP
`tool_input` shapes) — extend it, don't duplicate it, since both hooks
should share one `decideExitCode` implementation reading `containsSecret()`.

- [ ] **Step 1: Write the failing test for the extended checker recognizing a `gh issue` Bash call**

In `test/check-secret-in-tool-input.test.ts`, add these tests at the end of
the `describe("decideExitCode", ...)` block:

```typescript
  it("exits 1 for a secret-shaped value in a gh issue create command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: 'gh issue create --repo org/repo --title "PROJ-1: x" --body "CLIENT_SECRET=abcdefghijklmnop found"',
      },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 1 for a secret-shaped value in a gh issue comment command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh issue comment 42 --body 'SIGNING_KEY=abcdefghijklmnop'" },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 1 for a secret-shaped value in a gh issue edit command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh issue edit 42 --title 'PROJ-1: AWS key AKIAIOSFODNN7EXAMPLE found'" },
    });
    expect(decideExitCode(stdin)).toBe(1);
  });

  it("exits 0 for a clean gh issue create command", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'gh issue create --repo org/repo --title "PROJ-1: x" --body "clean"' },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for gh issue view, even with secret-shaped text present", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh issue view 42 # CLIENT_SECRET=abcdefghijklmnop" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for an unrelated Bash command (e.g. npm test), no gh issue involved", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });

  it("exits 0 for a non-Bash tool_name (e.g. still an Atlassian MCP call), scanned by the existing tool_input-object path instead", () => {
    const stdin = JSON.stringify({
      tool_name: "mcp__atlassian__addCommentToJiraIssue",
      tool_input: { commentBody: "clean comment" },
    });
    expect(decideExitCode(stdin)).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- check-secret-in-tool-input`
Expected: FAIL — the new `gh issue`-recognizing tests fail because
`decideExitCode` currently only scans `tool_input` as a JSON object
(correct for MCP calls) and has no `Bash`/`command`-string recognition
path at all, so a `gh issue create --body "CLIENT_SECRET=..."` command
string never gets scanned (its content lives inside a `command` string
value, which the current implementation's `JSON.stringify(toolInput)` pass
_would_ actually stringify and scan today — verify this specific claim by
running the test first; if the "exits 1" tests already pass because the
existing object-scan incidentally catches it, the ones that will
genuinely fail are the "exits 0 for gh issue view" test, since nothing
today distinguishes a `gh issue view` call from a `gh issue create` call —
the current implementation has no command-recognition logic and would
scan (and correctly ignore, since it's clean) that command's content
regardless of subcommand, so this specific test might pass by accident.
The two tests that reveal the real, required change are the "gh issue
view" one (must stay allowed) and confirming the recognizer function
exists at all — implement Step 3 regardless of which individual
assertions happen to already pass, since the goal is an explicit
recognizer, not accidental coverage.**

- [ ] **Step 3: Extend `scripts/check-secret-in-tool-input.ts` with a `gh issue` recognizer**

Add this function near the top of the file (after the imports, before
`decideExitCode`):

```typescript
/**
 * Whole-word membership check -- mirrors dev-loop's own isGhPrWrite
 * recognizer (scripts/check-secret-in-tool-input.ts in that repo), adapted
 * for "gh issue create/edit/comment" instead of "gh pr create/edit".
 * Over-matching here is harmless (see that repo's own comment for why) --
 * it just costs one extra scan pass, never a missed detection.
 */
function isGhIssueWrite(command: string): boolean {
  const hasWord = (word: string): boolean =>
    new RegExp(`(?:^|\\W)${word}(?:$|\\W)`).test(command);
  return (
    hasWord("gh") &&
    hasWord("issue") &&
    (hasWord("create") || hasWord("edit") || hasWord("comment"))
  );
}
```

Then update `decideExitCode`'s body: after the existing `const toolInput =
...` line and its `if (toolInput === null || toolInput === undefined)
return 0;` check, insert a `Bash`-specific branch before the generic
object-scan fallback:

```typescript
    const record = payload as Record<string, unknown> | null;
    const toolName = record?.tool_name;
    if (toolName === "Bash") {
      const command = (toolInput as Record<string, unknown>)?.command;
      if (typeof command !== "string" || command.length === 0) return 0;
      if (!isGhIssueWrite(command)) return 0;
      return containsSecret(command) ? 1 : 0;
    }

    const scanned = JSON.stringify(toolInput);
```

(This makes `Bash` calls take an explicit gh-issue-recognition path —
allowing `gh issue view`/any non-issue-write Bash call outright — while
every other `tool_name` keeps the existing generic object-scan behavior
unchanged.) Adjust the surrounding `try`/`return`/`catch` structure
minimally to fit this new branch into the existing function shape; do not
restructure anything else in the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- check-secret-in-tool-input`
Expected: PASS, including all pre-existing Atlassian-MCP-shaped tests
(regression check) plus the new `gh issue` ones.

- [ ] **Step 5: Run the full suite to verify nothing else broke**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 6: Write `.claude/hooks/block-github-secret-writes.sh`**

Adapt dev-loop's `.claude/hooks/block-secret-comments.sh` (the `gh`-Bash-
matcher variant) almost verbatim, since research-loop's existing
`block-secret-comments.sh` is the wrong shape to extend in place (it's
matched on specific MCP tool names via Claude Code's own hook `matcher`
field, not on `Bash` generically) — a second, separate hook file matched on
`Bash` is the correct structure, mirroring dev-loop's own file/matcher
split exactly:

```bash
#!/bin/bash
# block-github-secret-writes.sh — PreToolUse hook for Bash calls that
# write to a GitHub Issue.
#
# Requires `jq` on PATH (confirmed present: jq-1.7.1). Denies (exit 2) any
# gh issue create/edit/comment call whose command string contains a
# secret-shaped value (per src/redact.ts's containsSecret(), via the
# shared scripts/check-secret-in-tool-input.ts checker -- the same checker
# research-loop's existing Atlassian-MCP hook uses, extended in this
# change to also recognize gh issue create/edit/comment Bash calls).
#
# Mandatory Phase 1 launch blocker per docs/future-enhancements.md's Jira
# label-trigger design -- this hook must exist before ticket-refine writes
# any real recon/attack/verify content to a GitHub Issue (see SKILL.md's
# Ticket content protocol / routing rule).
#
# Adapted from dev-loop's own .claude/hooks/block-secret-comments.sh (its
# gh-Bash-matcher variant, for gh pr create/edit) -- same fail-closed exit-
# code contract:
#   0 -- clean, not a gh issue write, or no secret-shaped content found -> hook exit 0 (allow)
#   3 -- secret-shaped content found                                    -> hook exit 2 (deny)
#   2 -- the check itself failed (bad stdin, bad module)                 -> hook exit 2 (deny)
#   anything else (checker crashed/unrunnable)                          -> hook exit 2 (deny)
#
# The untrusted command string travels to the checker via stdin only --
# never interpolated into a shell command or passed as an argv element
# (which would leak it into ps/proc process listings on a shared host).

set -u

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: jq not found on PATH (required by the GitHub secret-scan hook) -- install jq. Denying to stay fail-closed." >&2
  exit 2
fi

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
JQ_EXIT=$?

if [ "$JQ_EXIT" -ne 0 ]; then
  echo "BLOCKED: could not parse this tool call's input (malformed JSON) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
  exit 2
fi

# Cheap pre-filter: only a command mentioning gh, issue, AND (create,
# edit, or comment) as whole words is worth scanning at all. Every other
# Bash call (git, npm test, gh pr create, gh issue view, etc.) short-
# circuits here without ever invoking Node.
if ! printf '%s' "$COMMAND" | grep -qw "gh"; then
  exit 0
fi
if ! printf '%s' "$COMMAND" | grep -qw "issue"; then
  exit 0
fi
if ! printf '%s' "$COMMAND" | grep -Eqw "create|edit|comment"; then
  exit 0
fi

CHECKER="${CLAUDE_PROJECT_DIR:-}/scripts/check-secret-in-tool-input.ts"

EXIT_CODE=2
if [ -f "$CHECKER" ]; then
  printf '%s' "$INPUT" | node "$CHECKER" 2>/dev/null
  EXIT_CODE=$?
fi

case "$EXIT_CODE" in
  0)
    exit 0
    ;;
  3)
    echo "BLOCKED: this gh issue create/edit/comment command contains a secret-shaped value (matched a known secret name/format pattern in src/redact.ts). Never write a raw env var value, .envrc/.env content, API key, token, or password into a GitHub Issue -- report presence/shape only (e.g. \"reads API_KEY from env\"), the same rule SKILL.md's Ticket content protocol already requires for Jira." >&2
    exit 2
    ;;
  *)
    echo "BLOCKED: could not verify this gh issue command is free of secret-shaped content (the secret-scan check itself failed to run) -- denying rather than risking an unverified write. Retry, or report this to a human if it keeps failing." >&2
    exit 2
    ;;
esac
```

Make it executable:
```bash
chmod +x .claude/hooks/block-github-secret-writes.sh
```

- [ ] **Step 7: Register the new hook in `.claude/settings.json`**

Update `.claude/settings.json`'s `hooks.PreToolUse` array to add a second
entry (leaving the existing Atlassian-matcher entry untouched):

```json
{
  "alwaysThinkingEnabled": true,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__atlassian__(addCommentToJiraIssue|editJiraIssue|addWorklogToJiraIssue|createIssueLink|createJiraIssue|createConfluencePage|updateConfluencePage|createConfluenceFooterComment|createConfluenceInlineComment)",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/block-secret-comments.sh"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/block-github-secret-writes.sh"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 8: Write the end-to-end hook test**

Create `test/hooks/block-github-secret-writes.test.mjs`, closely modeled
on dev-loop's own `test/hooks/block-secret-comments.test.mjs` (the `gh
pr`-matcher variant) but targeting `gh issue create/edit/comment` and this
new hook file:

```javascript
// End-to-end test of .claude/hooks/block-github-secret-writes.sh, driven
// via real piped stdin JSON the same shape Claude Code sends a PreToolUse
// hook for a Bash tool call. Run standalone with:
//   node test/hooks/block-github-secret-writes.test.mjs
// (not wired into npm test/vitest -- this drives an actual child
// process/bash script, not an in-process unit, matching this repo's
// existing plain-script convention for the sibling Atlassian hook test.)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync, renameSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const HOOK_PATH = join(REPO_ROOT, ".claude", "hooks", "block-github-secret-writes.sh");

let failures = 0;

function runHook(stdinJson, env = {}) {
  return spawnSync("bash", [HOOK_PATH], {
    input: stdinJson,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, ...env },
  });
}

function check(name, condition, detail) {
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
  }
}

// --- Case 1: secret-shaped gh issue create body is denied ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: 'gh issue create --repo org/repo --title "PROJ-1: x" --body "CLIENT_SECRET=abcdefghijklmnop found hardcoded"' },
  });
  const result = runHook(stdin);
  check("secret-shaped gh issue create: exit code is 2", result.status === 2, `got ${result.status}`);
  check("secret-shaped gh issue create: stderr is non-empty", result.stderr.trim().length > 0);
  check(
    "secret-shaped gh issue create: stderr does not contain the actual secret value",
    !result.stderr.includes("abcdefghijklmnop"),
    result.stderr,
  );
}

// --- Case 2: secret-shaped gh issue comment body is denied ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "gh issue comment 42 --body 'SIGNING_KEY=abcdefghijklmnop'" },
  });
  const result = runHook(stdin);
  check("secret-shaped gh issue comment: exit code is 2", result.status === 2, `got ${result.status}`);
}

// --- Case 3: clean gh issue create body is allowed ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: 'gh issue create --repo org/repo --title "PROJ-1: x" --body "clean"' },
  });
  const result = runHook(stdin);
  check("clean gh issue create: exit code is 0", result.status === 0, `got ${result.status}, stderr: ${result.stderr}`);
}

// --- Case 4: unrelated Bash command (e.g. npm test) is allowed without invoking the checker at all ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  const result = runHook(stdin);
  check("unrelated Bash command: exit code is 0", result.status === 0, `got ${result.status}`);
}

// --- Case 5: gh issue view (not create/edit/comment) is allowed even with secret-shaped text present ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "gh issue view 42 # CLIENT_SECRET=abcdefghijklmnop" },
  });
  const result = runHook(stdin);
  check("gh issue view: exit code is 0", result.status === 0, `got ${result.status}`);
}

// --- Case 6: gh pr create (not gh issue) is allowed by this hook -- it's not this hook's surface ---
{
  const stdin = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: 'gh pr create --title "x" --body "CLIENT_SECRET=abcdefghijklmnop"' },
  });
  const result = runHook(stdin);
  check("gh pr create (not gh issue): exit code is 0 -- out of this hook's scope", result.status === 0, `got ${result.status}`);
}

// --- Case 7: simulated checker crash fails closed (exit 2), with a distinct reason ---
{
  const brokenCheckerPath = join(REPO_ROOT, "scripts", "__test_broken_checker__.ts");
  writeFileSync(brokenCheckerPath, "throw new Error('simulated checker crash');\n");
  const realCheckerPath = join(REPO_ROOT, "scripts", "check-secret-in-tool-input.ts");
  const backupPath = join(REPO_ROOT, "scripts", "__check-secret-in-tool-input.ts.bak");
  try {
    renameSync(realCheckerPath, backupPath);
    try {
      renameSync(brokenCheckerPath, realCheckerPath);
      const stdin = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh issue create --body irrelevant" },
      });
      const result = runHook(stdin);
      check("checker-failure: exit code is 2 (fail closed)", result.status === 2, `got ${result.status}`);
      check(
        "checker-failure: stderr reason is distinguishable from the secret-found reason",
        result.stderr.includes("could not verify"),
        result.stderr,
      );
    } finally {
      renameSync(realCheckerPath, brokenCheckerPath);
      renameSync(backupPath, realCheckerPath);
    }
  } finally {
    try {
      unlinkSync(brokenCheckerPath);
    } catch {
      // already cleaned up above
    }
  }
}

// --- Case 8: jq missing from PATH fails closed (exit 2) with a message distinguishable from the malformed-JSON case ---
{
  const noJqDir = mkdtempSync(join(tmpdir(), "no-jq-path-"));
  const binsToLink = {
    bash: "/bin/bash",
    cat: "/bin/cat",
    grep: "/usr/bin/grep",
    node: process.execPath,
  };
  try {
    for (const [name, target] of Object.entries(binsToLink)) {
      try {
        symlinkSync(target, join(noJqDir, name));
      } catch {
        // best-effort
      }
    }
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: 'gh issue create --title "PROJ-1" --body "irrelevant"' },
    });
    const result = runHook(stdin, { PATH: noJqDir });
    check(
      "jq missing from PATH: exit code is 2 (fail closed)",
      result.status === 2,
      `got ${result.status}, stderr: ${result.stderr}`,
    );
    check(
      "jq missing from PATH: stderr mentions jq/not found, not malformed JSON",
      /jq/i.test(result.stderr) && /not found/i.test(result.stderr) && !/malformed JSON/i.test(result.stderr),
      result.stderr,
    );
  } finally {
    rmSync(noJqDir, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll checks passed.");
}
```

- [ ] **Step 9: Run the new end-to-end hook test**

Run: `node test/hooks/block-github-secret-writes.test.mjs`
Expected: `All checks passed.` (exit code 0).

- [ ] **Step 10: Run the existing Atlassian hook's own end-to-end test as a regression check**

Run: `node test/hooks/block-secret-comments.test.mjs`
Expected: `All checks passed.` — confirms Step 3's shared-checker extension
didn't break the pre-existing Atlassian-MCP path.

- [ ] **Step 11: Run the full vitest suite**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 12: Commit**

```bash
git add .claude/hooks/block-github-secret-writes.sh .claude/settings.json scripts/check-secret-in-tool-input.ts test/check-secret-in-tool-input.test.ts test/hooks/block-github-secret-writes.test.mjs
git commit -m "$(cat <<'EOF'
feat(hooks): add mandatory secret-redaction hook for the new GitHub write surface

Per docs/future-enhancements.md's Jira label-trigger design: the GitHub-
Issue secret-redaction hook is a launch blocker for Phase 1, not a fast-
follow, since ticket-refine's routing-rule changes (next task) will start
writing real recon/attack/verify content to GitHub. Adapts dev-loop's own
gh-Bash-matcher hook pattern (block-secret-comments.sh's gh-pr variant),
since this write surface is also a raw gh Bash call, not a named MCP
tool. Extends the existing shared checker (check-secret-in-tool-input.ts)
with a gh-issue-create/edit/comment recognizer rather than duplicating
containsSecret()'s detection logic in a second module.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `SKILL.md` — Step 0.5 (rename/link the GitHub Issue) + the Jira/GitHub content-routing rule

**Files:**
- Modify: `.claude/skills/ticket-refine/SKILL.md`
- Modify: `docs/skills.md` (document the routing rule and the new step, per
  `CLAUDE.md`'s requirement to read this doc first — already done as part
  of this plan's research)

**Interfaces:**
- Consumes: the GitHub Issue created by Task 4 (referenced by title
  convention `"<JIRA-KEY>: ..."`, discoverable via `gh issue list --search`
  the same way `GitHubClient.findIssueByJiraKey` does, but the skill itself
  calls `gh` directly via `Bash` — it has no access to the TypeScript
  `GitHubClient` class, only the CLI); `Config.jira.mentionAccountId`
  (Task 2, referenced by the human running the loop knowing the value, not
  read programmatically by the skill — the skill is told the value as part
  of its own invocation context, same as it's told `targetRepo` today via
  reading `pipeline.<project>.config.json` itself if needed).
- Produces: no code interface — this is a prompt/spec change. Task 7
  (manual verification) is the only later consumer, and it consumes the
  *behavior* this task specifies, not a code interface.

**This is the core Phase 1 change.** Two changes to `SKILL.md`:

**(a) New Step 0.5, "Open/link the GitHub Issue"**, inserted between
existing Step 0 (Triage & route) and Step 1 (Interpret) — main.ts (Task 4)
already created or found the mirror Issue with a placeholder title before
spawning this skill; this step's job is to look it up, rename it with the
real ticket summary, and remember its URL for the rest of the run:

```markdown
### Step 0.5 — Open/link the GitHub Issue

Before Interpret, find this run's GitHub Issue mirror (`main.ts` already
created or found it right after claiming the ticket, per Phase 1 of
docs/future-enhancements.md's Jira label-trigger design):

```bash
gh issue list --repo <github.repo from pipeline.<project>.config.json> \
  --search 'in:title "<TICKET-KEY>:"' --state all --json number,url,title
```

Exactly one match is expected (idempotency is `GitHubClient`'s job,
already run before this skill started). Rename it now that you have the
real ticket summary (read via `getJiraIssue`, same call Interpret would
make anyway — doing it here just moves the read earlier):

```bash
gh issue edit <number> --repo <github.repo> --title "<TICKET-KEY>: <ticket summary>"
```

Remember this Issue's number/URL for the rest of the run — every comment
this skill posts from Step 1 onward that the routing rule below classifies
as GitHub-only goes to this same Issue via `gh issue comment <number>
--repo <github.repo> --body "..."`, never a new Issue per comment.

If no matching Issue is found at all (the pre-run creation in `main.ts`
failed and was logged, per its own never-throw contract) — proceed anyway,
without a GitHub Issue for this run. Note this once in `progress.jsonl`
(`"phase": "triage", "event": "note"`, detail: "no GitHub Issue found for
this ticket -- proceeding without one") and route what would have been
GitHub-only content into a single Jira working comment instead, for this
run only. Do not fail or bounce the run over a missing mirror Issue — it's
an infrastructure gap, not a spec-readiness problem.
```

**(b) Rewrite "Ticket content protocol"** to implement the routing rule —
replace the entire section (currently items 1-6, defining Jira as the sole
destination for all working comments) with:

```markdown
## Ticket content protocol

**This skill never writes to the Jira description field.** Tickets are
authored by many different stakeholders in many different styles;
normalizing or overwriting someone else's ticket into our house format is
bad practice regardless of how good the result is. The original
description stays exactly as written, permanently.

**Routing rule (Phase 1 of docs/future-enhancements.md's Jira label-
trigger design): Jira gets only four kinds of content. Everything else
goes to the GitHub Issue.**

Jira-worthy, and *only* these:
1. A blocking ambiguity that needs a human product decision (the
   `spec_ambiguous` bounce).
2. A scope call (the `too_large` bounce and its drafted split).
3. An explicit confirmation request (something this skill genuinely cannot
   resolve without asking).
4. A passing-verdict pointer: the `Refined Spec — ready for ticket-to-pr`
   comment, now shrunk to a short pointer + evidence summary rather than
   the full write-up (see below).

No per-comment judgment call beyond this list — if content doesn't fit one
of these four categories, it goes to GitHub, full stop.

**Every Jira comment written under this protocol must @-mention
`jira.mentionAccountId`** (from `pipeline.<project>.config.json`) — a new
requirement Phase 1 introduces; no such convention existed before. Use
Jira's `@[accountId]` mention syntax in the comment body (ADF format via
`addCommentToJiraIssue`'s `contentFormat: "adf"`, or the equivalent
markdown mention syntax if using `contentFormat: "markdown"`).

GitHub-only (posted as a comment on this run's mirror Issue, via `gh issue
comment <number> --repo <github.repo> --body "..."`, per Step 0.5): recon
findings, devil's-advocate attack findings, verifier results, working/
interpretation notes, bounce evidence detail — anything in-the-weeds/
engineering-shaped. Still concise, allowed to be technical (GitHub Issues
is a developer-shaped surface — markdown, code refs, no @-mention
requirement).

1. **All work-in-progress** (interpretation notes, recon findings,
   assumption attacks, iteration updates) flows through **GitHub Issue
   comments** during the run, not Jira — this is the change from the
   pre-Phase-1 behavior, where all of this went to Jira working comments.
   The Jira description is never used as a scratchpad, and never
   rewritten, exactly as before.
2. **On a passing verdict**, write **one Jira comment**, titled exactly
   `Refined Spec — ready for ticket-to-pr`, @-mentioning
   `jira.mentionAccountId`, containing:
   - A one-paragraph summary (not the full Overview/AC/Scope write-up).
   - A plain-URL pointer to the GitHub Issue, which itself carries the
     full `### Overview` / `### Acceptance Criteria` / `### Scope` refined
     spec content as its own comment (see item 4 below) — `ticket-to-pr`
     reads the GitHub Issue as its real work order, not this Jira comment,
     once dev-loop migrates in Phase 2; until then, this Jira comment's
     pointer is what a human clicks through to review the real content.
   - The @-mention.
3. **On a bounce**, write **one Jira comment**, titled exactly
   `Ticket-Refine Bounce — <failure_category>`, @-mentioning
   `jira.mentionAccountId`, containing the same fixed
   Verdict/Summary/Needs-from-you header as before, but with the free-form
   evidence section replaced by a pointer to the GitHub Issue comment
   carrying the full evidence — unless the bounce category is itself one
   of the four Jira-worthy kinds above (e.g. `spec_ambiguous` naming the
   specific ambiguous readings *is* the blocking-ambiguity content Jira is
   for) — in that case, the ambiguity/scope-call/confirmation-request
   content itself stays in this Jira comment directly, and only the
   *supporting* evidence (grounding detail, attack findings that fed the
   judgment) goes to GitHub.
4. **The GitHub Issue itself carries the full refined-ticket content** on
   a passing verdict — post the complete `### Overview` / `### Acceptance
   Criteria` / `### Scope` template (identical structure to the old
   full-detail Jira comment) as a GitHub Issue comment, titled in its own
   first line `## Refined Spec — ready for ticket-to-pr` (GitHub has no
   comment-title field, so this is a markdown heading instead).
5. **On re-pickup** (an existing `Refined Spec`/`Ticket-Refine Bounce`
   Jira comment found, or an existing GitHub Issue comment of the
   equivalent title found): update that same comment/Issue-comment in
   place rather than posting a new one each cycle, on both sides
   independently — Jira's pointer comment and the GitHub Issue's full-
   detail comment are each their own idempotent target.
6. The Step 7 verifier checks the GitHub Issue comment's content and
   format (the full Overview/AC/Scope now lives there, not in Jira) — a
   refined ticket without these sections in the GitHub Issue, or without
   the GitHub Issue existing at all, is not ready by definition.
7. **Never write an absolute filesystem path** into any Jira comment *or*
   GitHub Issue comment — this machine's home directory is an email
   address, so an absolute path leaks PII into either surface equally.
   Refer to files by repo-relative path only.
8. **Never write a raw env var value, `.envrc`/`.env` file content, or any
   credential/token/key/password value into a Jira comment, GitHub Issue
   comment, `progress.jsonl` note, or the always-emitted result line** —
   Ground's worktree lives inside the target repo's own directory tree
   specifically so `direnv` picks up its real local env, which means that
   env can contain real secrets. Report presence/shape only, never the raw
   value — this rule now applies to the GitHub write surface exactly as it
   already applied to Jira. **Code-level backstop on both surfaces**: the
   existing `PreToolUse` hook (`.claude/hooks/block-secret-comments.sh`)
   denies a matching Jira/Confluence write; a new, equivalent hook
   (`.claude/hooks/block-github-secret-writes.sh`) denies a matching `gh
   issue create`/`edit`/`comment` Bash call — see `CHANGELOG.md`'s Phase 1
   entry. Neither hook is a replacement for following this rule; each is a
   heuristic backstop that won't catch every shape a secret could take.
```

Also update the "Bouncing (any step)" section's numbered evidence body to
reference GitHub per the routing rule above (the fixed three-line header
stays in Jira per item 3's "unless the bounce category is itself Jira-
worthy" carve-out; the free-form evidence detail moves to GitHub except
when the bounce category *is* the Jira-worthy content itself).

- [ ] **Step 1: Read `docs/skills.md` again immediately before editing** (per `CLAUDE.md` — already read once during this plan's research; re-confirm nothing changed on disk since then with `git diff docs/skills.md` before starting, since this task runs in a later session turn than the initial research read).

- [ ] **Step 2: Insert Step 0.5 into `SKILL.md`**

Insert the new `### Step 0.5 — Open/link the GitHub Issue` section (full
text above) between the existing `### Step 0 — Triage & route` section and
`### Step 1 — Interpret` section.

- [ ] **Step 3: Replace the "Ticket content protocol" section**

Replace the entire existing "## Ticket content protocol" section (items
1-6) with the rewritten version above (items 1-8, plus the routing-rule
preamble).

- [ ] **Step 4: Update the "Bouncing (any step)" section's evidence-location wording**

In the numbered list under "## Bouncing (any step)", update item 2's
body text (the comment-writing step) to note: "the free-form evidence
below the fixed header lives in Jira only when the bounce category
itself is Jira-worthy content per the routing rule (e.g. `spec_ambiguous`
naming the ambiguous readings); otherwise this comment's evidence section
is a pointer to the GitHub Issue comment carrying the full detail."

- [ ] **Step 5: Update `docs/skills.md`**

In the `## ticket-refine` section's numbered step list, add a `0.5.` entry
between `0.` and `1.` briefly describing the new step (one sentence, "opens/
renames this run's mirror GitHub Issue"). Add a new subsection ("##
Jira/GitHub content routing (Phase 1)") documenting the routing rule and
the design decision from Task 4 about *where* Issue creation happens
(loop-runner-owned, not skill-owned) — mirroring how `docs/skills.md`
already documents other cross-cutting rules (e.g. "## Ticket content
protocol" already exists there for the pre-Phase-1 Jira-only version;
update that reference too, since `docs/skills.md`'s own content should
stay in sync with `SKILL.md`'s).

- [ ] **Step 6: Verify the changes read coherently end-to-end**

Read through the full modified `SKILL.md` file once, checking: Step 0.5
correctly references `main.ts`'s pre-run creation (Task 4); every mention
of "working comments" elsewhere in the file (Steps 1-6, "Cleanup", the
Definition-of-ready checklist) is consistent with the new routing rule
(working content → GitHub, not Jira); the verdict.json schema section is
unaffected (verdict.json's own contract doesn't change — it's Jira/GitHub
comment content that changes, not the machine-readable verdict).

No automated test covers `SKILL.md` itself (it's a prompt, not code) — this
step's manual read-through is the check.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/ticket-refine/SKILL.md docs/skills.md
git commit -m "$(cat <<'EOF'
feat(ticket-refine): implement Phase 1's Jira/GitHub content routing rule

New Step 0.5 opens/renames this run's mirror GitHub Issue (created by
main.ts right after claim, per the prior task) before Interpret. Rewrites
the Ticket content protocol: Jira now carries only four content types
(blocking ambiguity, scope call, confirmation request, passing-verdict
pointer) -- everything else (recon/attack/verify findings, working notes,
bounce evidence detail) moves to the GitHub Issue as comments. Every Jira
comment under this protocol must now @-mention jira.mentionAccountId, a
new requirement. Per docs/future-enhancements.md's Jira label-trigger
design, Phase 1.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update `docs/future-enhancements.md` and `CHANGELOG.md`

**Files:**
- Modify: `docs/future-enhancements.md`
- Modify: `CHANGELOG.md`

**Interfaces:** none — documentation only, the final task.

Per `CLAUDE.md`'s convention: "when one of these lands, move its entry to
`CHANGELOG.md` and delete it from here." Phase 1 has now landed (Tasks
1-6); Phase 0 was already moved in an earlier session. This task moves
*only* the Phase-1-relevant portion, since Phase 2 (dev-loop reading its
work order from GitHub) explicitly has not landed and stays in
`docs/future-enhancements.md` as still-open work — do not delete the whole
"## Jira label-based trigger..." entry, only rewrite it to reflect what's
now done vs. still open.

- [ ] **Step 1: Rewrite the `docs/future-enhancements.md` entry**

Replace the "**Phased rollout**" bullet list's Phase 1 bullet (currently
describing Phase 1 as not-yet-done) with a short "DONE, see CHANGELOG.md"
pointer, matching the style already used for the Phase 0 bullet. Update
the "**Not yet scoped / explicitly deferred**" paragraph at the end of the
entry to remove the two items this plan resolved ("exact step in
ticket-refine where GitHub Issue creation happens" — resolved by Task 4's
design decision) and keep everything else genuinely still open (PR
lifecycle edge cases, Jira parent/child subtasks, GitHub's concurrency-safe
claim mechanism, Jira-comment-shape hook thresholds, dev-loop
Issue-sharing, dev-loop status labels — all Phase-2-or-later concerns this
plan didn't touch). Also record the two design decisions this plan made
that the doc had explicitly left open: (a) Issue creation happens in
`main.ts`'s composition root, not inside the skill's own Step 0/intake
turn; (b) the cross-link format is a plain URL in a comment on both sides
(already specified by the doc itself — confirm this wasn't itself one of
the "not yet scoped" items; if it was listed as open, mark it resolved
here since Task 6 implements exactly the doc's own already-specified plain-
URL sketch).

- [ ] **Step 2: Add the `CHANGELOG.md` entry for Phase 1**

Add a new entry at the top of `CHANGELOG.md` (after the two entries this
plan's Tasks 1/2 already added — repoLabel and github.repo/
mentionAccountId — or combine into one entry if those are still fresh from
the same session; use judgment on whether one combined entry or several
reads better, but every substantive change in this plan must be traceable
from `CHANGELOG.md`), titled `## 2026-09-16 — Jira label-based trigger,
Phase 1: GitHub Issue mirror + content routing`, summarizing: `GitHubClient`
added (`src/github-client.ts`), Issue creation wired into `main.ts` right
after claim (with the design rationale from Task 4), the new
`block-github-secret-writes.sh` mandatory-launch-blocker hook, and
`SKILL.md`'s routing-rule rewrite (Jira narrowed to four content types,
GitHub carries everything else, new @-mention requirement). Cross-
reference `docs/future-enhancements.md`'s entry the way every other
CHANGELOG entry in this file already does.

- [ ] **Step 3: Run the full suite one final time**

Run: `npm test`
Expected: PASS, all green — final confirmation before this plan's last
commit.

- [ ] **Step 4: Commit**

```bash
git add docs/future-enhancements.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: move Phase 1 (GitHub Issue mirror + content routing) to CHANGELOG.md

Phase 1 of the Jira label-trigger design has landed (prior commits this
session). Rewrites future-enhancements.md's entry to reflect Phase 0 and
Phase 1 as done, keeping only genuinely still-open Phase 2+ items (PR
lifecycle edge cases, GitHub concurrency-safe claim, dev-loop Issue-
sharing, etc.) in the "Not yet scoped" list. Records the two design
decisions this session made where the doc had left the call open: Issue
creation lives in main.ts's composition root (not the skill's own Step
0/intake turn), and the cross-link format is the doc's own already-
specified plain URL in a comment on both sides.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

**Spec coverage** (against docs/future-enhancements.md's Jira label-
trigger entry, Phase 1 slice):
- GitHub Issue creation, one per Jira ticket, idempotent → Task 3 (client)
  + Task 4 (wiring).
- `GitHubClient` mirroring `JiraClient`'s interface style → Task 3.
- Per-project `github.repo` config → Task 2.
- Routing rule (Jira: 4 categories only; GitHub: everything else) →
  Task 6.
- @-mention requirement, `jira.mentionAccountId` config → Task 2 (config)
  + Task 6 (SKILL.md usage).
- Secret-redaction hook on the GitHub write surface, mandatory launch
  blocker, sequenced before content-routing → Task 5 (before Task 6).
- `repoLabel` port from dev-loop → Task 0 (verify gap) + Task 1 (port).
- Design decisions for the two "not yet scoped" items this plan resolves
  (exact ticket-refine step for Issue creation; this plan explicitly picks
  loop-runner/`main.ts`, not the skill itself) → Task 4's "Design decision"
  callout, recorded in Task 7's doc updates.
- Explicitly OUT of scope, correctly left untouched: dev-loop reading from
  GitHub (Phase 2), the merge-reconciliation pass (Phase 2/status-sync,
  belongs to dev-loop), GitHub's concurrency-safe claim mechanism (Phase 2
  concern), resolving the two `catalog-ui-*` configs' unrelated
  `claimStatus`/`statusNames` placeholders (explicitly excluded by the
  user).

**Placeholder scan**: no "TBD"/"add error handling"/"similar to Task N"
patterns — every step has concrete code or exact shell commands. The one
soft spot (Task 5 Step 2's discussion of "verify this specific claim by
running the test first") is deliberate: it's instructing the implementer
to *observe* actual behavior before assuming which assertions currently
fail, which is a legitimate TDD move (confirm red for the right reason),
not a placeholder for missing content — the implementation in Step 3 is
still fully specified regardless of that observation's outcome.

**Type consistency**: `GitHubIssue { number, url }` used consistently in
Task 3's interface, `RealGitHubClient`, and Task 4's `main.ts` wiring.
`Config.github.repo` (Task 2) is the single field name used by Task 3's
`RealGitHubClient` constructor, Task 4's instantiation, and Task 6's
`SKILL.md` reference. `Config.jira.mentionAccountId` (Task 2) is the field
name used consistently in Task 6. `Config.jira.repoLabel` (Task 1) matches
dev-loop's own field name exactly, confirmed against the live commit
(`88252e0`) rather than re-derived.
