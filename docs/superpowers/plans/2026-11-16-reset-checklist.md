# Reset to Zero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run reset-project -- --project=<p> --ticket=<KEY>` surveys every place earlier runs touched (local, git, Jira, GitHub, sandbox), prints one table, asks `Proceed? [y/N]`, runs the approved steps, then re-surveys and says whether the ticket is at zero.

**Architecture:** A small step framework in `src/core/reset/`: each area exports a factory returning `ResetStep[]`; a step's `survey()` is read-only and returns what it found plus a bound `run()` for the action. A runner collects all steps, renders the table, gates on approval, runs actions in area order, and re-surveys. The existing `planReset`/`executeReset` stay as the engine behind the local steps and keep serving whole-project resets unchanged.

**Tech Stack:** Node 24 (type-stripping, no build), TypeScript, vitest, `gh` CLI, Jira REST v3, `git`, `sbx`.

**Spec:** `docs/superpowers/specs/2026-11-16-reset-checklist-design.md`

## Global Constraints

- Per-ticket only. Whole-project resets (`--ticket` absent) keep today's code path and output byte-for-byte, including the `--yes` requirement.
- Survey is read-only. Nothing changes before `y`/`yes` (case-insensitive, trimmed); anything else exits 0 with nothing changed.
- `--dry-run`: print the table, exit 0, no prompt, no verify.
- No TTY on stdin and no `--yes`: print the table, then `[reset] no terminal to ask on: rerun with --yes after reviewing the table above.`, exit 1, nothing changed.
- Execute order: `sandbox`, `git`, `local`, then `jira` and `github`. Within an area, table order.
- One step failing never stops the others; its row reports `failed: <message>` in the final table.
- Final line: `[reset] <KEY> is at zero.` (exit 0) or `[reset] <KEY> is not at zero: <n> step(s) need you:` followed by one `  - <area> <step>: <why>` line each (exit 1).
- A row with nothing to do shows `-` as its action. A row unsafe to automate shows `needs you: <why>` and is never acted on.
- Comments: delete only when inside a run window of the role being reset AND starting with a prefix from `LOOP_COMMENT_PREFIXES`. Never any other comment.
- Branches: only `<TICKET>-*`. Delete a local branch only when: not on origin (`git ls-remote --heads origin`), no open PR, 0 commits ahead of `origin/<defaultBranch>`. Unpushed commits → `needs you`. Remote check failed → every branch row `needs you`.
- Never: rewrite a live lock holder's lock, touch v1 history, add/remove labels other than `roles.research.triggerLabel` / `roles.research.handoffLabel`, close/delete a pushed branch, PR, follow-up ticket or Issue (except `--close-remote`), change sandbox policy or secrets.
- Reset always loads the env file: `reset-project` becomes `node --env-file-if-exists="${DEVLOOP_ENV_FILE:-.env}" src/core/reset-cli.ts`; `reset-project:remote` stays as an alias of the same command. Missing credentials → Jira/GitHub rows `needs you: no credentials`; local/git/sandbox still run.
- Never print token values, env contents or absolute home paths in Jira/GitHub writes. Table paths use the existing `shortenPath` (`~/...`).
- Recent-window hold: 2 minutes (`120_000`), only for records with `jira_status_changed: true`.
- `--key=value` flags only (src/core/flags.ts).
- `npm test`, `npm run test:hooks`, `npx tsc --noEmit` green after every task. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.

## Review Focus

1. **A comment posted by the user by hand during a run window, without a loop prefix** → kept. Test in Task 6 (`keeps an in-window comment with no loop prefix`).
2. **Jira or `gh` unreachable mid-survey** (network error, 401) → that area's rows show `needs you: <first line of error>`, the rest of the table still prints and local/git still execute. Test in Task 8 (`a throwing survey becomes a needs-you row`).
3. **A worker starts between the table and `y`** → live-worker refusal re-checked right before execute; nothing runs. Test in Task 8 (`re-checks the live worker after approval`).
4. **`--role=dev` on a ticket whose research comment and record exist** → research comment, research records, research run dirs untouched; label ends as the handoff label. Test in Task 6 (`dev reset keeps research's comment`) and Task 4 (`dev scope keeps research records`).
5. **Stopped run with no `ended` and no record** (only a run dir with `progress.jsonl`) → its comments are still in a window and deleted. Test in Task 6 (`a run dir's progress.jsonl makes a window`).

---

### Task 1: Client reads and deletes (Jira comments/labels, GitHub Issues/PRs)

**Files:**
- Modify: `src/core/jira-client.ts` (interface, `StubJiraClient`, `RealJiraClient`)
- Modify: `src/core/github-client.ts` (interface, stub, real)
- Test: `test/core/jira-client.test.ts`, `test/core/github-client.test.ts`

**Interfaces:**
- Produces:
  - `interface JiraComment { id: string; created: string /* ISO */; firstLine: string; url: string }`
  - `JiraClient.listComments(ticketKey: string): Promise<JiraComment[]>` — pages `GET /rest/api/3/issue/<key>/comment?startAt=<n>&maxResults=100&orderBy=created` until `startAt+returned >= total`. `firstLine` = text of the first ADF block with text (paragraph or heading, concatenated `text` nodes), trimmed, max 120 chars. `url` = `<baseUrl>/browse/<key>?focusedCommentId=<id>`.
  - `JiraClient.deleteComment(ticketKey: string, commentId: string): Promise<void>` — `DELETE /rest/api/3/issue/<key>/comment/<id>`. Throws the existing request error (with `status`) on failure.
  - `JiraClient.getLabels(ticketKey: string): Promise<string[]>` — `GET issue/<key>?fields=labels`.
  - `GitHubIssue` gains `stateReason?: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null`.
  - `GitHubClient.findIssuesByJiraKey(jiraKey: string): Promise<GitHubIssue[]>` — same `gh issue list` search as `findIssueByJiraKey` but `--json number,url,state,stateReason`, all results, sorted by number ascending. `findIssueByJiraKey` keeps its signature and now returns the first **open** match, else the first match (so existing callers are unchanged for the single-Issue case).
  - `realOpenPrHeads(repo: string, exec?: ExecGhFn): (ticketKey: string) => Promise<{ head: string; url: string }[]>` — `gh pr list --repo <repo> --state open --search "<KEY> in:title,body" --json headRefName,url`, filtered to `headRefName` starting with `<KEY>-`.
  - Stubs throw the not-configured error, like their siblings.

- [ ] **Step 1: Write the failing tests** (fetch mocked with `vi.stubGlobal("fetch", ...)` as the file already does; `execFn` as `vi.fn`):
  - `listComments pages until total and extracts the first line` — two pages (total 101); first comment body `{type:"doc",content:[{type:"heading",content:[{type:"text",text:"✅ research-loop - "},{type:"text",text:"refined"}]}]}` → `firstLine === "✅ research-loop - refined"`; second-page URL contains `startAt=100`.
  - `deleteComment sends DELETE to the comment path` — asserts method and path `/rest/api/3/issue/TARS-1/comment/42`.
  - `deleteComment surfaces a 403 with its status` — rejects with `{ status: 403 }`.
  - `getLabels returns fields.labels` — `["pipeline:v2"]`; missing field → `[]`.
  - `findIssuesByJiraKey returns every match with stateReason, ascending` and `findIssueByJiraKey prefers an open Issue over a closed one`.
  - `realOpenPrHeads keeps only <KEY>- heads` — input heads `TARS-1-a`, `TARS-10-b`, `main` → only `TARS-1-a`.
- [ ] **Step 2: Run** `npx vitest run test/core/jira-client.test.ts test/core/github-client.test.ts` — FAIL (methods missing).
- [ ] **Step 3: Implement** the interfaces above. Update every other `JiraClient`/`GitHubClient` implementer in `test/` (fakes) so `npx tsc --noEmit` passes — grep `implements JiraClient` and `implements GitHubClient`.
- [ ] **Step 4: Run** the two test files, then `npm test && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(clients): Jira comment list/delete and labels; GitHub Issue list with close reason; open PR heads`.

### Task 2: Recent-window hold only after a Jira status change, 2 minutes, with a log line

**Files:**
- Modify: `src/core/iteration-log.ts` (`IterationRecord.jira_status_changed?: true`; `recentlyEnded`)
- Modify: `src/worker/context.ts` (`append` sets the flag), `src/worker/cycle.ts` (`DEFAULT_RECENT_WINDOW_MS = 120_000`; skip log)
- Test: `test/core/iteration-log.test.ts`, `test/worker/cycle.test.ts`

**Interfaces:**
- Produces: `recentlyEnded(records, now, windowMs): Map<string, number>` — ticket → ms since that record ended (was `Set<string>`); only records with `jira_status_changed === true` count. Callers that used `.has` keep working on a Map.
- How the flag is set: `buildCtx` wraps `deps.jira` so a successful `claimTicket` (returning true) or `transitionStatus` for key K adds K to `ctx.state.statusChanged: Set<string>`; `append(ctx, K, ...)` writes `jira_status_changed: true` when K is in the set, then deletes K.

- [ ] **Step 1: Write the failing tests:**
  - iteration-log: `a record without jira_status_changed never holds its ticket`; `a status-changing record holds for windowMs and reports its age` (ended 60 s ago, window 120 000 → map has ticket with value 60 000).
  - cycle: `a claimed-and-bounced research run writes jira_status_changed: true`; `a resume-dropped record has no jira_status_changed`; `a held ticket logs its age` — exact text `[worker] TARS-1 skipped: a run on it ended 45s ago` for 45 s, `ended 1m ago` for 60–119 s (under 60 s: whole seconds; else whole minutes, rounded down).
  - Update test (a) and any test that relied on the 10-minute window to the new rule.
- [ ] **Step 2: Run** `npx vitest run test/core/iteration-log.test.ts test/worker/cycle.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Log the skip line at the EXCLUDE step, once per held ticket per iteration. Drop the `resume-dropped` special case in `recentlyEnded` (it never sets the flag, so it's covered).
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `fix(worker): recent-window hold only after a Jira status change, 2 minutes, with a skip line`.

### Task 3: Step framework and table

**Files:**
- Create: `src/core/reset/step.ts`, `src/core/reset/table.ts`
- Test: `test/core/reset/table.test.ts`

**Interfaces:**
- Produces (`step.ts`):
  ```ts
  export type ResetArea = "local" | "git" | "jira" | "github" | "sandbox";
  export const AREA_ORDER: readonly ResetArea[] = ["sandbox", "git", "local", "jira", "github"];
  export interface Survey {
    found: string;            // short, one line ("none" when empty)
    action: string | null;    // null renders "-"
    needsYou?: string;        // set => never run, row shows "needs you: <why>"
    details?: string[];       // extra indented lines under the row (e.g. each comment to delete)
    run?: () => Promise<void>; // present iff action !== null && !needsYou
  }
  export interface ResetStep { area: ResetArea; name: string; survey(): Promise<Survey> }
  export interface SurveyedRow { step: ResetStep; survey: Survey; error?: string }
  export function atZero(row: SurveyedRow): boolean; // !error && action === null && !needsYou
  ```
- Produces (`table.ts`): `renderTable(title: string, rows: SurveyedRow[], status?: Map<SurveyedRow, "done" | string>): string` — columns `#  Area  Step  Found  Action`, fixed width, padded to the widest cell per column, `Found` truncated to 48 chars with `…`. `status` (after execute) replaces Action with `done` or `failed: <msg>`. `details` print as `      <line>` under their row.

- [ ] **Step 1: Write the failing tests:** `renders - for a null action`, `renders needs you: <why>`, `prints details indented under the row`, `truncates a long Found to 48 chars with …`, `numbers rows from 1`, `atZero is false for needsYou, error, or an action`. Assert exact strings for a 2-row table (title line, blank line, header, rows).
- [ ] **Step 2: Run** `npx vitest run test/core/reset/table.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(reset): step framework and table renderer`.

### Task 4: Local steps

**Files:**
- Create: `src/core/reset/local-steps.ts`
- Test: `test/core/reset/local-steps.test.ts` (temp `root`, as `test/core/reset-project.test.ts` does)

**Interfaces:**
- Consumes: `planReset`, `executeReset` (`src/core/reset-project.ts`), `ResetStep`/`Survey` (Task 3), `recentlyEnded` (Task 2).
- Produces:
  ```ts
  export interface ResetCtx {
    project: string; slug: string; ticket: string; role: ResetRole; config: Config | null; root?: string;
    jira: JiraClient | null; github: GitHubClient | null; openPrHeads: ((k: string) => Promise<{ head: string; url: string }[]>) | null;
    git: (args: string[], cwd: string) => Promise<string>; // execFile git, rejects on non-zero
    sandbox: SandboxAdapter | null; sandboxConfig: unknown;
    isAlive?: (pid: number, started: number) => boolean; now: () => Date; closeRemote: boolean;
  }
  export function localSteps(ctx: ResetCtx): ResetStep[]; // in order: run records, run dirs, session lock in-flight, recent-window hold
  ```
  Each step calls `planReset({ project: ctx.slug, ticket, role, config, root, isAlive })` in its own survey (so a re-survey is fresh). `run records`: found `N records in runs/v2/<slug>` (+ `, M refused` if any → `needsYou: "other role landed; --include-cross-role"`), action `archive N`. `run dirs`: found the run dir basenames, action `delete N`. `session lock in-flight`: found `<lock basename> (holder dead) -> <role> run`, action `clear`. The three runs share one `executeReset` call: the first `run()` executes the plan for all three, later ones are no-ops (a closure flag). Worktrees are NOT here (Task 5 owns them; pass a plan with `worktreesToRemove: []`). `recent-window hold`: a check only — found `held (ended Ns ago)` / `none`, action always `null`; after archive it reads clean.

- [ ] **Step 1: Write the failing tests:** `surveys records, dirs and a dead lock's flight for the ticket`; `run archives, deletes and clears; re-survey is clean`; `dev scope keeps research records` (role dev; research-only record stays in the live log); `a refused cross-role record is needs you`; `recent-window hold reads held before and none after archive`; `never touches worktrees`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Add an option `skipWorktrees?: boolean` to `ResetOptions` in `reset-project.ts` rather than mutating the plan.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(reset): local steps`.

### Task 5: Git steps

**Files:**
- Create: `src/core/reset/git-steps.ts`
- Test: `test/core/reset/git-steps.test.ts` (real `git init` repos in a temp dir, with a bare "origin", via `execFileSync`; `openPrHeads` faked)

**Interfaces:**
- Consumes: `ResetCtx` (Task 4).
- Produces: `gitSteps(ctx: ResetCtx): ResetStep[]` — in order `worktrees`, `local branches`, `pushed branches / PRs`. Repo = `config.targetRepo.path` else the v2 clone (`v2CloneDir`); no config → each row `needsYou: "no project config"`.
  - `worktrees`: `git worktree list --porcelain` entries plus dirs under `<repo>/.claude/worktrees/` named `<TICKET>-*` (role filter as today: research = `-ground`, dev = the rest, all = both). Action `remove N + prune`; run = `git worktree remove --force <path>` for registered ones (fallback `rm -rf` for unregistered dirs, path must be under `<repo>/.claude/worktrees/`), then `git worktree prune`. Role `research` skips the branch steps (they are dev-only: both later steps return found `-`, action null, when role is research).
  - `local branches`: `git for-each-ref refs/heads/<TICKET>-* --format=%(refname:short)`; for each: on origin? (`git ls-remote --heads origin <b>` non-empty), open PR? (`openPrHeads`), ahead = `git rev-list --count origin/<defaultBranch>..<b>` after `git fetch origin <defaultBranch>`. Deletable = not on origin, no PR, ahead 0 → action `delete N` (`git branch -D`, only these). Any with ahead > 0 and not on origin → `needsYou: "<b> has N unpushed commit(s)"`. `ls-remote`/`fetch`/`openPrHeads` throws → `needsYou: "remote check failed: <msg>"` and no deletes. A branch checked out in a worktree that Task's `worktrees` step removes is fine because sandbox→git order runs worktrees first; re-check before delete.
  - `pushed branches / PRs`: lists `<TICKET>-*` heads on origin and open PR URLs; action always null (listed). With `closeRemote`, the PR row is left to the close rows (Task 8).

- [ ] **Step 1: Write the failing tests:** `removes a ticket worktree and prunes git's entry`; `research scope only removes -ground worktrees`; `deletes a 0-ahead local-only branch`; `keeps a branch that is on origin`; `keeps a branch with an open PR`; `a branch with unpushed commits is needs you`; `a failing remote check makes the row needs you and deletes nothing`; `never matches TARS-10- for TARS-1`; `lists pushed branches and PRs without acting`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Remove worktree deletion from the per-ticket `executeReset` path only via the `skipWorktrees` option from Task 4 (whole-project behaviour unchanged).
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(reset): git steps (worktrees, local branches, pushed branches and PRs)`.

### Task 6: Jira and GitHub steps

**Files:**
- Create: `src/core/reset/jira-steps.ts`, `src/core/reset/github-steps.ts`, `src/core/reset/run-windows.ts`
- Modify: `src/core/types.ts` or a new `src/core/loop-comments.ts` for `LOOP_COMMENT_PREFIXES`
- Test: `test/core/reset/run-windows.test.ts`, `test/core/reset/jira-steps.test.ts`, `test/core/reset/github-steps.test.ts` (fake clients)

**Interfaces:**
- Consumes: `ResetCtx`, `JiraClient.listComments/deleteComment/getLabels/getStatus/transitionStatus/swapLabel/removeLabel`, `GitHubClient.findIssuesByJiraKey`.
- Produces:
  - `export const LOOP_COMMENT_PREFIXES: Record<Role, readonly string[]> = { research: ["✅ research-loop", "❌ research-loop"], dev: ["✅ dev-loop", "❌ dev-loop"] }` and `loopCommentRole(firstLine: string): Role | null` (strips a leading `#`s and spaces before matching).
  - `interface RunWindow { role: Role; from: number; to: number }` and `runWindows(ctx: ResetCtx): Promise<RunWindow[]>` — from every phase of the ticket in the live log AND `runs/v2/<slug>.reset-archive.jsonl`: `[started, ended + 120_000]`; plus every run dir of the ticket (any session) with a `progress.jsonl`: `[first ts, last ts + 120_000]` (field `ts`; lines that don't parse are skipped). Computed once per survey, before anything is archived — the runner surveys all rows before running any, so this holds.
  - `jiraSteps(ctx: ResetCtx, windows: () => Promise<RunWindow[]>): ResetStep[]` — `status`, `label`, `loop comments`, `follow-up tickets`.
    - `status`: target `config.roles.research.claimStatus.from` for every role. found = current; action `move to <target>` or null.
    - `label`: `all`/`research` target = `triggerLabel`, other = `handoffLabel`; `dev` target = `handoffLabel`, other = `triggerLabel`. found = whichever of the two pipeline labels are present (no other label is shown); action `swap to <target>` when target is absent or other is present, else null. Run = `swapLabel(key, other, target)` (one PUT; Jira's remove of an absent label is a no-op, so this covers add-only too).
    - `loop comments`: comments where `loopCommentRole(firstLine)` is a role in scope AND `created` falls in a window of that role. found `N (x research, y dev)`, details each `<created local HH:MM> <firstLine>`; action `delete N`. Run deletes each; a 403/404 on one → that comment stays and the row's run throws `could not delete <url>: <status>` after trying the rest (the runner shows it as failed and the verify re-survey still lists it → `needs you`).
    - `follow-up tickets`: `follow_up.ticket` from dev phases (live log + archive); action null.
    - `ctx.jira === null` → every row `needsYou: "no credentials"`.
    - `closeRemote` → `jiraSteps` returns `[]` (Task 8 adds the close rows).
  - `githubSteps(ctx: ResetCtx): ResetStep[]` — `mirror Issue` (role research/all only): found `#585 (closed, not planned)` / `#590 (open)` / `none`; action null always. `ctx.github === null` → `needsYou: "no credentials"`.

- [ ] **Step 1: Write the failing tests:**
  - run-windows: `phases in the live log and the archive make windows with 2 minutes of slack`; `a run dir's progress.jsonl makes a window`; `a malformed progress line is skipped`.
  - jira-steps: `deletes an in-window research comment`; `keeps an in-window comment with no loop prefix`; `keeps a loop-prefixed comment outside every window`; `dev reset keeps research's comment` (role dev: research comment in a research window is not listed); `a refused delete leaves the row failed and the re-survey needs you`; `status moves to claimStatus.from`; `label research: swap handoff to trigger`; `label dev: swap trigger to handoff`; `never touches other labels` (fake records every label op; only the two pipeline labels appear); `no credentials makes every row needs you`; `closeRemote yields no jira reset rows`.
  - github-steps: `reports a closed-not-planned Issue and never acts`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(reset): Jira and GitHub steps; loop comments matched by run window and prefix`.

### Task 7: Sandbox steps

**Files:**
- Modify: `src/sandbox/types.ts` (`resetSteps?`), `src/sandbox/sbx/adapter.ts`
- Create: `src/core/reset/sandbox-steps.ts`
- Test: `test/sandbox/sbx-adapter.test.ts` (or wherever the sbx adapter tests live — grep `cleanupOrphans`), `test/core/reset/sandbox-steps.test.ts`

**Interfaces:**
- Produces:
  - `SandboxAdapter.resetSteps?(scope: { prefix: string; ticket: string }, config: unknown): ResetStep[]` — `area: "sandbox"`.
  - sbx: one step `leftover sandboxes`: `sbx ls --json`, names starting with `sandboxInstancePrefix(project)` + `sandboxNamePart(ticket) + "-"`; action `remove N` (same `remove` as `cleanupOrphans`). `sbx` missing or `ls` failing → `needsYou: "sbx ls failed: <msg>"`. Never calls `sbx policy` or `sbx secret`.
  - `sandboxSteps(ctx: ResetCtx): ResetStep[]` — `ctx.sandbox?.resetSteps?.(...) ?? []`. The CLI picks the adapter from the project config's `sandbox.adapter` (via `src/sandbox/select.ts`); absent/`none` → no sandbox rows.
- [ ] **Step 1: Write the failing tests:** `lists and removes only this ticket's instances` (fake `run`: names `dl-12-webtarsthree-tars-1634-dev-abc123`, `dl-12-webtarsthree-tars-16340-dev-x`, `dl-12-webtarsthree-preflight-y` → only the first); `sbx ls failing is needs you`; `none adapter has no reset steps`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Export `sandboxNamePart` from `src/worker/skill-runner.ts` if not already exported.
- [ ] **Step 4: Run** `npm test && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(sandbox): adapters can bring reset steps; sbx lists and removes a ticket's leftover sandboxes`.

### Task 8: Runner and CLI

**Files:**
- Create: `src/core/reset/runner.ts`, `src/core/reset/close-steps.ts`
- Modify: `src/core/reset-cli.ts`, `package.json` (scripts)
- Test: `test/core/reset/runner.test.ts` (fake steps), `test/core/reset-cli.test.ts` (subprocess; add `--yes`/no-TTY/dry-run cases)

**Interfaces:**
- Consumes: everything above; `executeRemoteClose` (src/core/remote-close.ts).
- Produces:
  ```ts
  export interface RunnerIO { print(s: string): void; ask(q: string): Promise<string | null> /* null = no TTY */ }
  export interface RunnerOpts { title: string; ticket: string; dryRun: boolean; yes: boolean; preExecuteCheck: () => Promise<string | null> /* refusal message or null */ }
  export async function runChecklist(steps: ResetStep[], opts: RunnerOpts, io: RunnerIO): Promise<number>; // exit code
  export function closeSteps(ctx: ResetCtx): ResetStep[]; // area jira/github: "close ticket", "close mirror Issue", "close PR" wrapping executeRemoteClose's three parts; survey shows what it would close
  ```
  Flow: survey every step (a throwing survey → row `needsYou: <first line of error>`); print `renderTable("Reset <KEY> (role: <role>)", rows)`; if every row is at zero → print `[reset] <KEY> is already at zero.` exit 0. `dryRun` → print `[reset] --dry-run: nothing changed.` exit 0. Not `yes`: `ask("Proceed? [y/N] ")`; null → no-TTY message, exit 1; not y/yes → `[reset] declined: nothing changed.` exit 0. Then `preExecuteCheck()` (re-plans the live-worker check; `--ignore-live-worker` makes it return null) → refusal: print it, exit 1. Run each row's `run` in `AREA_ORDER` then table order; record `done`/`failed: <msg>`. Print the executed table with statuses. Re-survey everything, print `renderTable("After reset", rows)`, then the final at-zero line (Global Constraints) and return 0/1.
- CLI: per-ticket path builds `ResetCtx` (Jira/GitHub clients only when `credentialsFromEnv()` succeeds, else null; `git` via `execFile`), steps `[...sandboxSteps, ...gitSteps, ...localSteps, ...(closeRemote ? closeSteps : jiraSteps), ...githubSteps]`, and calls `runChecklist` with `io.ask` reading one line from `process.stdin` when `process.stdin.isTTY`, else null. Whole-project path unchanged. Live-worker refusal still checked before the table is acted on (via `preExecuteCheck`), and the table includes a `local  live worker` row showing `needs you: a live worker holds <lock>` when one is alive.
- package.json: `"reset-project": "node --env-file-if-exists=\"${DEVLOOP_ENV_FILE:-.env}\" src/core/reset-cli.ts"`, `"reset-project:remote"` identical.

- [ ] **Step 1: Write the failing tests:**
  - runner: `dry-run prints the table and runs nothing` (exit 0); `declined runs nothing` (`ask` → "n", exit 0); `no TTY without --yes runs nothing and exits 1`; `runs actions in area order` (rows given jira, local, sandbox, git → run order sandbox, git, local, jira); `a failing run doesn't stop the rest`; `a throwing survey becomes a needs-you row`; `re-checks the live worker after approval` (preExecuteCheck returns a message → nothing runs, exit 1); `exits 0 only when the re-survey is at zero` and prints `[reset] TARS-1 is at zero.`; `lists the steps that need you and exits 1`; `already at zero skips the prompt`.
  - reset-cli (subprocess, temp root, no credentials in env): `--ticket --dry-run prints the table with jira rows needs you: no credentials`; `--ticket without --yes and no TTY exits 1 and changes nothing`; `--ticket --yes archives the record and exits 1 because jira needs you` (no creds). Existing whole-project tests stay green unchanged.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run test:hooks && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(reset): per-ticket reset is a surveyed checklist with one approval and a verify pass`.

### Task 9: Research never reuses an Issue closed as not planned

**Files:**
- Modify: `src/main.ts` (`ensureMirrorIssue`), `.claude/skills/ticket-refine/SKILL.md` (Step 0.5), `.claude/skills/ticket-refine/VERSION` + its changelog if the skill keeps one (read `docs/skills.md` first)
- Test: the test file covering `ensureMirrorIssue` (grep it; if none, extract `ensureMirrorIssue`'s decision into `src/roles/research/mirror-issue.ts` as `pickMirrorIssue(issues: GitHubIssue[]): { reuse: GitHubIssue | null; previous: GitHubIssue[] }` and test that in `test/roles/research/mirror-issue.test.ts`)

**Interfaces:**
- Consumes: `GitHubClient.findIssuesByJiraKey` (Task 1).
- Produces: `pickMirrorIssue` — reuse = the newest Issue that is open, or closed with a reason other than `NOT_PLANNED`; previous = closed `NOT_PLANNED` ones newer-first. When reuse is null, `ensureMirrorIssue` creates a fresh Issue whose body ends with one line per previous: `Previous attempt: #<n>`.
- Skill Step 0.5: list with `--json number,url,title,state,stateReason`; use the open Issue (or the newest not-`NOT_PLANNED` one); for each `NOT_PLANNED` Issue, read its comments (`gh issue view <n> --json comments`) as **prior context only**: an unverified claim under the stance's rules, never a spec to copy, never a reason to treat the run as a re-pickup. Note it once in `progress.jsonl` (`event: "note"`, detail `prior attempt #<n> read as context`).

- [ ] **Step 1: Write the failing tests:** `reuses the open Issue`; `never reuses a closed not-planned Issue and lists it as previous`; `reuses a closed completed Issue` (existing re-pickup behaviour); `the fresh Issue body links each previous attempt`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** code and skill text; bump the skill version per docs/skills.md.
- [ ] **Step 4: Run** `npm test && npm run test:hooks && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(research): a mirror Issue closed as not planned is read as prior context, never reused`.

### Task 10: Docs and the live check on TARS-1634

**Files:**
- Modify: `docs/reset.md`, `.claude/skills/reset-project/SKILL.md`, `CHANGELOG.md` (Unreleased, `[core]` + `[research]` bullets), `docs/logging.md` (`jira_status_changed`)

- [ ] **Step 1: Docs.** reset.md: the checklist, the table, approval and `--yes`, the step table from the spec, exit codes, env file always loaded. Skill: an agent runs `--dry-run` first, shows the user the table in chat, and only after a yes reruns with `--yes`; `--close-remote` still confirmed in chat first. CHANGELOG: reset-to-zero checklist; 2-minute status-change-only hold with a skip line; research skips not-planned Issues.
- [ ] **Step 2: Run** `npm test && npm run test:hooks && npx tsc --noEmit` — PASS. Commit `docs(reset): the reset-to-zero checklist`.
- [ ] **Step 3: Live dry-run (read-only, safe).** `npm run reset-project -- --project=webtarsthree --ticket=TARS-1634 --dry-run`. Expected rows include: jira status `Blocked` → `move to To Do`; label `pipeline:v2:dev` → `swap to pipeline:v2`; loop comments listing dev's bounce comment; mirror Issue `#585 (closed, not planned)`; the stale TARS-1634 worktree/branch rows if present. **Show the table to the user and get a yes in chat before Step 4.**
- [ ] **Step 4: Live reset (after the user's yes).** Rerun with `--yes`. Expected final line: `[reset] TARS-1634 is at zero.` Then re-run `--dry-run`: expected `[reset] TARS-1634 is already at zero.`
- [ ] **Step 5:** Tell the user TARS-1634 is ready for `npm run loop -- --project=webtarsthree --sandbox=sbx --once --stream`.
