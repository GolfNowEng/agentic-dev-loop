# Host-side Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sandboxed dev run ends at `ready_to_push`. The loop on the host then re-signs the branch's unpushed commits as the operator and runs push-branch unchanged, on haiku. After that the run follows the normal landed path.

**Architecture:**
- **New adapter hook:** `hostPush?(config): boolean`. When it is true, dev's prompt gains `push=host`, and Phase 5 writes a `ready_to_push` verdict instead of pushing.
- **Two new worker modules:**
  - `host-sign.ts`: plain git, no LLM.
  - `host-push.ts`: makes a host worktree, signs, spawns haiku running push-branch, then reads the PR URL back from `gh` (a fact, never the agent's claim).
- **Who acts on the verdict:** `runDevPhase` turns `ready_to_push` into `landed` or `bounced`. It is the only code that ever sees `ready_to_push`.

**Tech Stack:** TypeScript (node 24, `--experimental-strip-types`), vitest, git, gh.

**Spec:** `docs/superpowers/specs/2026-11-17-host-side-signing-design.md`

## Global Constraints

- **No hook bypass:** never `--no-verify`, `-n`, `HUSKY=0` or `core.hooksPath`. This holds in code, tests and prompts.
- **Never rewrite pushed history:** refuse if any commit in the range is reachable from an `origin/*` ref.
- **No "sbx" outside the folder:** the word "sbx" may not appear outside `src/sandbox/sbx/` and the registry (`test/structure.test.ts`).
- **Host runs unchanged:** with no `--sandbox`, the dev prompt and the whole dev path are byte-identical to today's.
- **Host push spawn model:** `"haiku"`.
- **Commits:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Gates:** `npm test`, `npm run test:hooks` and `npx tsc --noEmit` are green after every task.
- **Git calls:** use `execFile`, never a shell, with the args as an array.

## Review Focus

1. **Signing fails partway** (agent locked, key missing, a hook fails on commit 2 of 3): the branch must be restored exactly to the old tip, and the run bounces. This is tested in Task 3.
2. **push-branch renames the branch** (version guard: `TARS-1-x` becomes `feat/TARS-1-x`): the loop must find the PR under the new name. Task 4 reads HEAD's branch after the spawn.
3. **The PR already exists** (a retry after a push failure): push-branch edits it, and the loop finds the same URL. Task 4 tests that the lookup returns an existing PR.
4. **A `ready_to_push` verdict on a host run** (no hostPush) must never push or land. Task 5 makes it `error`/`agent_error`.
5. **Linux-built `node_modules`** from the sandbox must never be used for host hooks. Task 4 always runs `npm ci` in a fresh host worktree.

---

### Task 1: Verdict: the `ready_to_push` outcome

**Files:**
- Modify: `src/core/types.ts`, `src/core/verdict.ts`
- Test: `test/core/verdict.test.ts`

**Interfaces:**
- Produces:
  - `export interface ReadyToPush { branch: string; pr_title: string; pr_body: string }` in types.ts.
  - `ExecutorVerdict.outcome` becomes `RunOutcome | "ready_to_push"`.
  - New field `ExecutorVerdict.ready_to_push?: ReadyToPush`, set only when the outcome is `"ready_to_push"`.
  - `RunOutcome` and `PhaseEntry.outcome` don't change, so `ready_to_push` can never be persisted.

- [ ] **Step 1: Failing tests** in `verdict.test.ts`, under `describe("parseVerdict executor: ready_to_push")`:
  - **A valid verdict:** `{...validExecutor, outcome: "ready_to_push", pr: null, branch: "TARS-1-x", pr_title: "feat(TARS-1): x", pr_body: "## Jira Ticket\n..."}` parses to `outcome === "ready_to_push"` and `ready_to_push` equal to `{branch, pr_title, pr_body}`.
  - **Missing or empty fields:** if `branch`, `pr_title` or `pr_body` is missing or empty, the result is `outcome === "error"` and `failure_category === "agent_error"`.
  - **A bad branch name:** `"a b"`, `"-x"` or `"x;y"` gives agent_error. Allowed: `/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/` with no `..`.
  - **The other outcomes:** `landed`/`bounced` verdicts with no such fields still parse unchanged, and `ready_to_push` is undefined.
- [ ] **Step 2:** Run `npx vitest run test/core/verdict.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. The executor shape check accepts `"ready_to_push"`, then validates the three fields and copies them into `ready_to_push`. Keep `VERDICT_OUTCOMES`/`RUN_OUTCOMES` for the other profiles unchanged.
- [ ] **Step 4:** The tests pass, and `npx tsc --noEmit` is clean. Fix any exhaustive switch on `ExecutorVerdict.outcome`; `runDevPhase` gets a temporary `ready_to_push` → agent_error branch, which Task 5 replaces.
- [ ] **Step 5:** Commit `feat(dev): executor verdict outcome ready_to_push`.

### Task 2: Adapter hook `hostPush` and the `push=host` prompt argument

**Files:**
- Modify: `src/sandbox/types.ts`, `src/sandbox/sbx/adapter.ts`, `src/core/build-prompt.ts`, `src/worker/skill-runner.ts`
- Test: `test/sandbox/sbx/adapter.test.ts`, `test/core/build-prompt.test.ts`, `test/worker/skill-runner.test.ts`

**Interfaces:**
- Produces:
  - `SandboxAdapter.hostPush?(config: unknown): boolean`. The doc comment says commits are signed and pushed by the loop on the host, and the agent stops at `ready_to_push`.
  - The sbx adapter returns `true`.
  - `SkillPromptArgs.hostPush?: boolean`. When it is true, the prompt ends with ` push=host`, after the host-skill pointers.
  - `"push"` is added to `RESERVED_KEYS`.

- [ ] **Step 1: Failing tests:**
  - `buildSkillPrompt({role:"dev", ..., hostPush:true})` ends with ` push=host`.
  - Without `hostPush`, or with it false, the output is exactly the same as today.
  - Research with `hostPush:true` throws (`push=host is dev-only`).
  - A host skill named `push` throws (reserved).
  - The sbx adapter: `hostPush(validConfig) === true`.
  - Skill-runner: the dev prompt with an adapter that has `hostPush: () => true` ends with ` push=host`. Without a sandbox it is unchanged; reuse the existing exact-string test. The research prompt never has it.
- [ ] **Step 2:** Run the three test files. Expected: FAIL.
- [ ] **Step 3:** Implement. In skill-runner, set `const hostPush = deps.sandbox?.adapter.hostPush?.(deps.sandbox.config) === true;` and pass it only for `role === "dev"`.
- [ ] **Step 4:** Tests and the structure test pass. Comments outside `sbx/` must not use the word "sbx".
- [ ] **Step 5:** Commit `feat(sandbox): hostPush hook; dev prompt gains push=host`.

### Task 3: `host-sign.ts`: re-sign the unpushed range

**Files:**
- Create: `src/worker/host-sign.ts`
- Test: `test/worker/host-sign.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GitFn = (args: string[], cwd: string) => Promise<string>; // rejects with stderr on non-zero
  export interface SignArgs { worktree: string; branch: string; ticketKey: string; defaultBranch: string; git: GitFn }
  export type SignResult =
    | { ok: true; base: string; oldTip: string; newTip: string; signed: number }
    | { ok: false; reason: string; restored: boolean };
  export async function signUnpushed(a: SignArgs): Promise<SignResult>;
  export function realGit(env?: NodeJS.ProcessEnv): GitFn; // execFile("git", args, { cwd, env })
  ```
- **The algorithm**, in order. The first failure returns `ok:false`.
  1. **Preconditions** (when one fails: `restored:false`, nothing changed):
     - `status --porcelain` is empty, else the reason is `worktree <wt> has uncommitted changes`.
     - `rev-parse --abbrev-ref HEAD` equals `branch`, else `HEAD is <x>, expected <branch>`.
     - `branch` contains `ticketKey` as a token (`containsTicketToken` from github-client), else `branch <b> does not name <KEY>`.
  2. **Base:** `ls-remote --heads origin <branch>`.
     - If it is present, the base is `origin/<branch>`.
     - Otherwise the base is `origin/<defaultBranch>`.
     - Run `rev-parse --verify <base>^{commit}`.
  3. **Range:** `rev-list <base>..HEAD`.
     - If it is empty: `nothing to sign on <branch>`.
     - `rev-list --merges <base>..HEAD` must be empty, else `<sha> is a merge commit; refusing to rewrite`.
     - For each sha, `for-each-ref --contains <sha> refs/remotes/origin` must be empty, else `<sha> is already on <ref>; refusing to rewrite pushed history`.
  4. **Re-sign:**
     - Record `oldTip` and `oldTree = rev-parse HEAD^{tree}`.
     - Run `rebase --exec "git commit --amend --no-edit --reset-author -S" <base>`.
     - If it throws, run `rebase --abort` (ignoring errors), then `reset --hard <oldTip>`. Return `{ok:false, reason:"signing failed: <first stderr line>", restored:true}`.
  5. **Proof:**
     - `rev-parse HEAD^{tree}` must equal `oldTree`.
     - Every sha in `log --format=%G? <base>..HEAD` must be `G`.
     - If either fails, run `reset --hard <oldTip>`. The reason is `tree changed after signing` or `<sha> signature is <c>, expected G`, with `restored:true`.

- [ ] **Step 1: Failing tests.** Use a real temp repo with a bare `origin`. In `beforeAll`:
  - Run `ssh-keygen -t ed25519 -N "" -f <tmp>/k`.
  - The repo config sets:
    - `gpg.format=ssh`
    - `user.signingkey=<tmp>/k`
    - `gpg.ssh.allowedSignersFile=<tmp>/allowed`, containing `"t@example.com " + pubkey`
    - `user.email=t@example.com` and `user.name=T`
  - A non-ssh `GIT_CONFIG_GLOBAL=/dev/null` in env keeps the operator's config out.

  The tests:
  - `signs only the unpushed commits and resets the author`: origin/main has 1 commit, and the branch `X-1-a` adds 2 unsigned commits authored `agent@sandbox`. Expect `ok`, `signed === 2`, every `%G?` is `G`, every `%ae` is `t@example.com`, the tree is unchanged, and origin/main's sha is unchanged.
  - `base is origin/<branch> when the branch is already pushed`: push 1 commit of the branch, then add 1 unsigned commit. Expect `signed === 1`.
  - `refuses a merge commit`: `ok:false`, the reason matches `/merge commit/`, and HEAD is unchanged.
  - `refuses a dirty worktree`, `a wrong HEAD`, and `a branch without the key`: each returns its exact reason above.
  - `restores the old tip when signing fails`: set `user.signingkey=<tmp>/missing`. Expect `ok:false`, `restored:true`, and HEAD equal to oldTip.
  - `restores when a pre-commit hook fails on the second commit`: the hook exits 1 when a marker file exists in the commit's tree. Expect `restored:true` and HEAD equal to oldTip.
  - `nothing to sign`: if the branch equals the base, expect `ok:false`.
- [ ] **Step 2:** Run `npx vitest run test/worker/host-sign.test.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3:** Implement as specified.
- [ ] **Step 4:** Tests and the gates pass.
- [ ] **Step 5:** Commit `feat(dev): host-sign re-signs only the unpushed range`.

### Task 4: `host-push.ts`: worktree, sign, push-branch on haiku, PR from gh

**Files:**
- Create: `src/worker/host-push.ts`
- Modify: `src/core/paths.ts` (`isPipelineWorktree` accepts `-push`)
- Test: `test/worker/host-push.test.ts`, `test/core/paths.test.ts`

**Interfaces:**
- Consumes:
  - `signUnpushed`/`GitFn` (Task 3).
  - `ReadyToPush` (Task 1).
  - `SpawnClaudeOpts`/`SpawnClaudeResult` (`src/core/spawn-claude.ts`).
- Produces:
  ```ts
  export interface HostPushDeps {
    repoDir: string; repoRoot: string; githubRepo: string; defaultBranch: string;
    git: GitFn; spawn: (o: SpawnClaudeOpts) => Promise<SpawnClaudeResult>;
    run: (cmd: string, args: string[], cwd: string) => Promise<string>; // for direnv exec npm ci
    findOpenPrUrlForBranch: (branch: string) => Promise<string | null>;
    pushBranchSkill: string; // abs path, default ~/.claude/skills/push-branch/SKILL.md
    timeoutMin: number; maxBudgetUsd: number; stream: boolean; env: NodeJS.ProcessEnv;
    log: (m: string) => void;
  }
  export type HostPushResult =
    | { ok: true; pr: string; branch: string; signed: number; oldTip: string; newTip: string; costUsd: number }
    | { ok: false; detail: string; costUsd: number };
  export async function hostPush(ticketKey: string, runId: string, ready: ReadyToPush, d: HostPushDeps): Promise<HostPushResult>;
  export function hostPushPrompt(a: { skill: string; worktree: string; branch: string; title: string; body: string }): string;
  export const HOST_PUSH_MODEL = "haiku";
  export const HOST_PUSH_TOOLS = "Bash,Read";
  ```
- **The flow:**
  1. Set `wt = <repoDir>/.claude/worktrees/<KEY>-<runId>-push`.
     - If `wt` exists, remove it with `worktree remove --force`. That's allowed only because the path is ours (`isPipelineWorktree`). The sandbox's own worktree is never touched.
     - Run `worktree add <wt> <branch>`. If it fails, return `ok:false`, with a detail naming the branch.
  2. Run `run("direnv", ["exec", wt, "npm", "ci"], wt)`. The sandbox's node_modules are Linux builds.
  3. Call `signUnpushed({worktree: wt, branch, ticketKey, defaultBranch, git})`. The `git` given wraps every call as `direnv exec <wt> git ...`, so the husky hooks see `.envrc`.
  4. Check that `pushBranchSkill` exists. If not: `push-branch skill not found at <path>`.
  5. Spawn:
     - `model: HOST_PUSH_MODEL`
     - `allowedTools: HOST_PUSH_TOOLS`
     - `cwd: repoRoot`, so dev-loop's hooks apply
     - `addDir: repoDir`
     - `prompt: hostPushPrompt(...)`
     - no sandbox
  6. Read the branch with `git rev-parse --abbrev-ref HEAD` in `wt`, since push-branch may have renamed it. Then `pr = await findOpenPrUrlForBranch(branch)`.
     - If it is null: `ok:false`, with the detail `push-branch did not leave an open PR for <branch>` plus the first 300 characters of the spawn's result text.
  7. Remove the worktree with `worktree remove <wt>` (no `--force`). This always runs, in a `finally`, and a failure here is only logged.
- **`hostPushPrompt`** is the exact template below, with the values filled in literally. The title and body go in verbatim.
  ```
  Read <skill> with the Read tool and follow it exactly, in its content-supplied mode, with --no-jira.
  Work only in <worktree>: run every command as `direnv exec <worktree> <command>` from that directory (`cd <worktree> && direnv exec <worktree> git push -u origin <branch>`).
  The branch is <branch>; its commits are already signed; do not commit, amend, rebase or reset.
  Never pass --no-verify or skip a hook. If the push or the PR fails, stop and print the error.
  --title "<title>"
  Body:
  <body>
  ```
- **`findOpenPrUrlForBranch`:** `gh pr list --repo <repo> --head <branch> --state open --json url --jq '.[0].url // empty'`. Add it as `realOpenPrUrlForBranch(repo, exec)` in `github-client.ts`, validating the branch with the Task 1 regex.

- [ ] **Step 1: Failing tests:**
  - `paths.test.ts`: `isPipelineWorktree("TARS-1", "TARS-1-20261117T090121Z-push")` is true.
  - `host-push.test.ts`, with fake `git`/`run`/`spawn`/`findOpenPrUrlForBranch` that record calls:
    - **The happy path:**
      - The calls come in order: worktree add, `direnv exec <wt> npm ci`, signing, spawn, rev-parse, PR lookup, worktree remove.
      - The spawn has `model "haiku"` and `cwd` equal to repoRoot.
      - The prompt contains the title and body verbatim, and contains `--no-jira`.
      - The result is `ok` with the PR.
    - **A rename:** if rev-parse returns `feat/TARS-1-x`, the PR lookup uses `feat/TARS-1-x`.
    - **A sign failure:** gives `ok:false` with the sign reason, the spawn is never called, and the worktree is still removed.
    - **No PR after the spawn:** gives `ok:false` with the detail `push-branch did not leave an open PR for TARS-1-x`.
    - **The skill file is missing:** gives `ok:false` naming the path, and the spawn is never called.
    - **Bypass words:** `hostPushPrompt` never contains `no-verify` except in the sentence that forbids it. Assert that `--no-verify` appears exactly once.
  - Use a sign stub by injecting `signUnpushed` as an optional dep (`sign?: typeof signUnpushed`), so this task doesn't depend on real signing.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Gates pass.
- [ ] **Step 5:** Commit `feat(dev): host push via unchanged push-branch on haiku`.

### Task 5: `runDevPhase` acts on `ready_to_push`; wiring

**Files:**
- Modify: `src/roles/dev/phase.ts`, `src/worker/cycle-steps.ts`, `src/worker/context.ts`, `src/main.ts`
- Test: `test/roles/dev/phase.test.ts`, `test/worker/cycle.test.ts` (wiring only)

**Interfaces:**
- Consumes: `HostPushResult` (Task 4) and `ExecutorVerdict.ready_to_push` (Task 1).
- Produces:
  - `DevPhaseDeps.hostPush?: (ready: ReadyToPush) => Promise<HostPushResult>`.
  - `WorkerDeps.hostPush?: (ticketKey: string, runDir: string, ready: ReadyToPush) => Promise<HostPushResult>`.
  - `cycle-steps` binds the ticket and run dir.
  - `main.ts` builds it only when `ctx.sandbox.adapter.hostPush?.(ctx.sandbox.config) === true`, with `runId` taken from the run dir's last segment after its first `-`.
- **The behavior in `runDevPhase`,** after parsing and before any Jira write:
  - **If `ready_to_push` comes without `deps.hostPush`:** the verdict becomes `agentErrorVerdict("ready_to_push but this run has no host push (push=host was not given)")`.
  - **If `ready_to_push` comes with `deps.hostPush`:** call it, and add its `costUsd` to the entry's `cost_usd`.
    - `ok`: the verdict becomes `{...verdict, outcome:"landed", pr: res.pr}`. The entry gets `detail` equal to `verdict.detail + " Host-signed <n> commit(s) (<oldTip7>→<newTip7>) and pushed <branch>."`. The existing landed path then runs: the Jira move to Code Review with QA Notes, and the GitHub comment.
    - `ok:false`: the verdict becomes `{...verdict, outcome:"bounced", failure_category:"env_setup", pr:null, detail: "host push failed: " + res.detail + ". Work committed locally on " + ready.branch + ", not pushed."}`. The existing bounce path then runs: the comment, then Blocked.
    - If `hostPush` throws, treat it as `ok:false` with the error's message.
- **Where the entry's outcome comes from:** the resolved verdict, so the entry type stays `RunOutcome`.

- [ ] **Step 1: Failing tests** in `phase.test.ts`:
  - `ready_to_push + hostPush ok → landed`: `transitionStatus` is called with prOpen. `entry.pr` is the host PR. `entry.cost_usd` is the skill cost plus the push cost. The detail matches `/Host-signed 2 commit/`.
  - `ready_to_push + hostPush fails → bounced env_setup`: a bounce comment is posted, the status moves to Blocked, and the detail matches `/^host push failed: /`.
  - `ready_to_push + hostPush throws`: the same as a failure.
  - `ready_to_push without hostPush → error/agent_error`: no `transitionStatus`, and `hostPush` is never called.
  - **Existing behavior:** the landed and bounced tests don't change.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and wire it in. `main.ts` uses `realGit`, `spawnClaudeRun`, an `execFile`-based `run`, `realOpenPrUrlForBranch(config.github.repo)`, and the dev limits `timeoutMin: 20` and `maxBudgetUsd: 2`. It is built only for an adapter whose `hostPush` is true, so the plain loop has no `hostPush` dep.
- [ ] **Step 4:** Gates pass.
- [ ] **Step 5:** Commit `feat(dev): the loop signs and pushes a ready_to_push run on the host`.

### Task 6: ticket-to-pr Phase 5 with `push=host`, plus docs

**Files:**
- Modify: `.claude/skills/ticket-to-pr/SKILL.md`, `docs/skills.md`, `docs/sandbox-sbx.md`, `CHANGELOG.md`
- Test: `test/sandbox/sbx/host-skills-drift.test.ts`, or a new `test/skills/ticket-to-pr-push-host.test.ts`. It asserts that SKILL.md mentions the `push=host` argument and `ready_to_push`, and that the verdict schema lists `branch`, `pr_title` and `pr_body`.

- [ ] **Step 1: Failing test:** a skill text test checks that:
  - the Arguments section documents `push=host`;
  - Phase 5 has a `push=host` branch that names `outcome: "ready_to_push"`;
  - the schema lists `branch`, `pr_title` and `pr_body`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Edit SKILL.md:**
  - **Arguments:** optional `push=host`. It sets `PUSH_MODE=host`, and the default is `PUSH_MODE=self`.
  - **Phase 5:** add a new step 0, "If `PUSH_MODE=host`", with this content:
    - Do not read push-branch, and do not push.
    - Make sure every change is committed (`git status --porcelain` is empty).
    - Do not rename the branch: the host's push-branch does the version guard.
    - Write `verdict.json` with `outcome: "ready_to_push"`, `phase_reached: "pr"`, `pr: null`, `branch` (the literal current branch), and `pr_title`/`pr_body` from Phase 4 step 7 verbatim, plus all the metrics and `qa_notes`.
    - Run Cleanup. The worktree is removed: the work is committed, and the loop makes its own worktree.
    - Stop.
  - **Schema:** add the optional `branch`, `pr_title` and `pr_body`, required when the outcome is `ready_to_push`.
  - **Docs:**
    - `docs/skills.md`: the verdict contract.
    - `docs/sandbox-sbx.md`: a new section, "§10 Signed commits", covering why, the flow, what is left on failure, and that the host's ssh-agent must be unlocked.
    - CHANGELOG, tagged `[dev]` and `[core]`: TARS-1634 GH013 and the fix.
- [ ] **Step 4:** Gates pass.
- [ ] **Step 5:** Commit `feat(dev): ticket-to-pr stops at ready_to_push under push=host; docs`.

### After the plan: the TARS-1634 live run (controller, with the operator's OK)

These steps aren't a subagent task.

1. **Rename the branch back:** rename the local branch `feat/TARS-1634-okta-docs-stale` to `TARS-1634-okta-docs-stale`. Resume only finds `<TICKET>-*` branches, and the host's push-branch will put the `feat/` prefix back. It's local only, with nothing on origin.
2. **Prep Jira by hand** (operator OK required): delete the GH013 bounce comment, then move Blocked to To Do.
3. **The operator runs:** `npm run loop -- --project=webtarsthree --phase=dev --sandbox=sbx --once --stream`.
