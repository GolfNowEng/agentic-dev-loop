# Robot Fake Env Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The robot's direnv loads fake values built from `.envrc.example`, never the target repo's real `.envrc`, in both sandbox modes.

**Architecture:**
- The loop writes `<REPO_DIR>/.claude/worktrees/.envrc` (the fake) and a marker-only file, then allows the fake.
- sbx mounts the marker file read-only over each real root env file, and preflight checks that from inside a sandbox.
- With no sandbox, a `Read` deny rule covers the real files.
- Host push keeps the real env by running `direnv exec <REPO_DIR>`.

**Tech Stack:** TypeScript (node 24, `--experimental-strip-types` style `.ts` imports), vitest, sbx v0.54, direnv 2.37.

**Spec:** docs/superpowers/specs/2026-11-17-robot-fake-env-design.md

## Global Constraints

- Marker line, exact: `# dev-loop fake env: generated from .envrc.example, never real values`
- Fake path: `<REPO_DIR>/.claude/worktrees/.envrc`. Marker file: `<REPO_DIR>/.claude/worktrees/.dev-loop-hidden-env`.
- Never read, print or log a value from a real `.envrc`/`.env`. Tests use only temp dirs and fake values.
- Never run `direnv allow` on any file but the loop's own fake (and, inside a sandbox, the covered `.envrc` paths, which then hold only the marker).
- Plain loop (no sandbox) keeps working; host push behaviour is unchanged.
- Gates: `npm test`, `npm run test:hooks`, `npx tsc --noEmit` green after each task.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. An example value containing `'`, `$(...)` or spaces must come out single-quoted and literal (Task 1 test).
2. No `.envrc.example` on origin, or git failing, must give an empty fake, never a throw that stops the loop (Task 1 test).
3. A target repo with a `.env` but no `.envrc` (catalog-ui-public): it is still covered in sbx and still denied with none (Task 2 and Task 3 tests).
4. direnv missing on the host: writing the fake still succeeds and the allow is skipped (Task 1 test).
5. The v2-clone layout (REPO_DIR inside dev-loop's root, so not its own mount): the overlay still covers the clone's root env files (Task 3 test).

---

### Task 1: The fake env file — `src/core/fake-env.ts`

**Files:**
- Create: `src/core/fake-env.ts`
- Test: `test/core/fake-env.test.ts`

**Interfaces:**
- Produces:
  - `FAKE_ENV_MARKER: string`
  - `fakeEnvPaths(repoDir: string): { envrc: string; hidden: string }`
  - `parseEnvExample(text: string): Array<[name: string, value: string]>`
  - `renderFakeEnvrc(entries: Array<[string, string]>): string`
  - `interface FakeEnvDeps { git(args: string[], cwd: string): Promise<string>; direnvAllow(path: string): Promise<void> }`
  - `writeFakeEnv(repoDir: string, defaultBranch: string, d: FakeEnvDeps): Promise<{ names: string[]; allowed: boolean }>`
  - `realFakeEnvDeps: FakeEnvDeps`

- [ ] **Step 1: Write the failing tests:**
  - `parseEnvExample`:
    - keeps `export A=x`, `  export B="two words"` → `two words`, `export C='q'` → `q`;
    - skips `# export D=1`, blank lines and `FOO=bar` (no export);
    - keeps `export E=$(echo pwned)` with the value literal.
  - `renderFakeEnvrc`:
    - the first line is the marker;
    - `export A='x'`;
    - a value `it's` renders `'it'\''s'`;
    - ends with a newline.
  - `writeFakeEnv`, with a temp repoDir and fake deps:
    - it writes both files, and the hidden file is the marker plus a newline;
    - it returns the names;
    - git is called with `["show", "origin/master:.envrc.example"]` and cwd repoDir;
    - `direnvAllow` gets the fake path;
    - git throws → the fake is marker-only, `names: []`, no throw;
    - `direnvAllow` throws → the files are still written, `allowed: false`;
    - unchanged content → still allowed, and the file's mtime is unchanged (written only on change);
    - it creates `.claude/worktrees` when missing.
- [ ] **Step 2:** Run `npx vitest run test/core/fake-env.test.ts`; it is expected to FAIL (the module is missing).
- [ ] **Step 3: Implement.**
  - Write via temp file plus `rename`.
  - `realFakeEnvDeps.git` uses `execFile("git", ["-C", cwd, ...args])`.
  - `direnvAllow` uses `execFile("direnv", ["allow", path])`.
- [ ] **Step 4:** The tests PASS, and so does `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(core): loop writes a fake .envrc for the robot from .envrc.example`.

### Task 2: Deny reads with no sandbox, and refresh before every run

**Files:**
- Modify: `src/core/spawn-claude.ts` (`SpawnClaudeOpts`, `settingsJson`)
- Modify: `src/worker/skill-runner.ts` (`SkillRunnerDeps`, `makeRunSkill`)
- Test: `test/core/spawn-claude.test.ts`, `test/worker/skill-runner.test.ts`

**Interfaces:**
- Consumes: `writeFakeEnv`, `realFakeEnvDeps` (Task 1); `rootEnvFiles(dir)` from `src/sandbox/sbx/adapter.ts`. Move it to `src/core/env-files.ts` along with `isEnvFile`. sbx re-imports it from there, so core never imports an adapter.
- Produces:
  - `SpawnClaudeOpts.denyReads?: string[]` (absolute file paths). It shares `DENY_DIR`'s check, but the error names `denyReads`.
  - `SkillRunnerDeps.refreshFakeEnv?: () => Promise<void>`. Default: `writeFakeEnv(repoDir, config.targetRepo.defaultBranch, realFakeEnvDeps)`, with a failure logged, never thrown.

- [ ] **Step 1: Write the failing tests:**
  - `settingsJson({ denyReads: ["/abs/t/.envrc"] })` gives `{"permissions":{"deny":["Read(//abs/t/.envrc)"]}}`. Combined with `denyEditsUnder`, both rule sets land in one list.
  - A relative or glob path throws, naming `denyReads`.
  - `makeRunSkill`, with `.envrc` and `.env` in the temp repo:
    - both roles' spawn opts have `denyReads` equal to `[<repo>/.env, <repo>/.envrc]`;
    - `.envrc.example` is not in the list;
    - an empty repo gives `[]`;
    - `refreshFakeEnv` is called once per run, before spawn.
- [ ] **Step 2:** Run the two test files; they are expected to FAIL.
- [ ] **Step 3: Implement.** Rescan `rootEnvFiles(repoDir)` per run, not once at construction.
- [ ] **Step 4:** The tests PASS, and all three gates are green.
- [ ] **Step 5:** Commit `feat(core): deny the robot Read on the target repo's real env files; refresh the fake each run`.

### Task 3: sbx hides the real files — `src/sandbox/`

**Files:**
- Modify: `src/sandbox/types.ts` (`PreflightCtx`, `RunSandboxSpec`: add `repoDir?: string`)
- Modify: `src/sandbox/sbx/adapter.ts`
- Modify: `src/worker/skill-runner.ts`, `src/main.ts` (pass `repoDir`)
- Modify: `scripts/sbx.mjs` (template build: mount only ROOT; drop `confirmAllow` and the allow loop)
- Test: `test/sandbox/sbx/adapter.test.ts`, `test/worker/skill-runner.test.ts`

**Interfaces:**
- Consumes: `fakeEnvPaths`, `FAKE_ENV_MARKER` (Task 1); `rootEnvFiles` (Task 2).
- Produces:
  - `hideMounts(repoDir: string): string[]`, exported from adapter.ts: one `<hidden>:<repoDir>/<f>:ro` per `rootEnvFiles(repoDir)`.
  - `create` passes these after the skill mounts.
  - Ruling: covering keys off `repoDir`, not off every mount. That handles the v2-clone layout, where repoDir is not its own mount.

- [ ] **Step 1: Write the failing tests** (temp repoDir with `.envrc`, `.env.local` and `.envrc.example`):
  - `prepare({ …, repoDir })` create args end with the two hide mounts, sorted, without `.envrc.example`.
  - After create, `prepare` runs `exec <name> sh -c "direnv allow '<repo>/.claude/worktrees/.envrc' && direnv allow '<repo>/.envrc'"`. A failure throws `could not allow the fake .envrc inside the sandbox`.
  - Preflight:
    - the fake files are missing on the host → it throws `the robot's fake env is missing` before any create;
    - the check string contains `echo dl-step:hidden && head -n1 '<repo>/.envrc' | grep -qxF '<MARKER>'`, one per covered file;
    - `echo dl-step:envrc && direnv exec '<repo>/.claude/worktrees' true` replaces the old repo-root envrc check;
    - the last step `hidden` failing → it throws `a real .envrc is visible inside the sandbox`;
    - no `note: the sandbox agent can read` warning;
    - the repoRoot env-file refusal is unchanged.
  - Without `repoDir`, create args and the check are exactly as today. The existing CHECK and create tests stay green.
  - `skill-runner` with a sandbox: `run.repoDir` equals the absolute repo dir.
- [ ] **Step 2:** Run the adapter and skill-runner tests; they are expected to FAIL.
- [ ] **Step 3: Implement.**
  - In preflight, before the case check: if `ctx.repoDir` is set and `!existsSync(fakeEnvPaths(repoDir).envrc)`, throw the missing message.
  - Update the old "blocked .envrc" message to say the loop's fake isn't allowed: `restart the loop`.
  - In `scripts/sbx.mjs`, the template build mounts only ROOT, and its help text drops "type allow".
- [ ] **Step 4:** The tests PASS, and all three gates are green.
- [ ] **Step 5:** Commit `feat(sbx): cover the target repo's real env files with a read-only marker and check it in preflight`.

### Task 4: Startup wiring and host push keeps the real env

**Files:**
- Modify: `src/main.ts` (before preflight: `await writeFakeEnv(repoDirFor(config, slug), config.targetRepo.defaultBranch, realFakeEnvDeps)`, logging the names count, never values; pass `repoDir` to preflight)
- Modify: `src/worker/host-push.ts` (`wtGit`, `npm ci`, `hostPushPrompt`: `direnv exec <repoDir>` instead of `<wt>`)
- Test: `test/worker/host-push.test.ts`

**Interfaces:**
- Consumes: Task 1, and Task 3's `PreflightCtx.repoDir`.
- Produces:
  - `hostPushPrompt(a: { skill; worktree; repoDir; branch; title; body })`. The new `repoDir` field is used as `direnv exec ${repoDir}`, with `cd ${worktree}` kept.

- [ ] **Step 1: Write the failing tests:**
  - The host-push run calls use `["exec", <repoDir>, "git", …]` and `["exec", <repoDir>, "npm", "ci"]` with cwd = the worktree.
  - The prompt contains `cd <wt> && direnv exec <repoDir> git push -u origin <branch>`, and never `direnv exec <wt>`.
- [ ] **Step 2:** The tests are expected to FAIL.
- [ ] **Step 3: Implement.** Check how `wtGit` gets its cwd: `direnv exec DIR cmd` runs in the caller's cwd, so pass `wt` as cwd.
- [ ] **Step 4:** All three gates are green.
- [ ] **Step 5:** Commit `fix(dev): host push names the repo dir for direnv so it keeps the real env; loop writes the fake at startup`.

### Task 5: Skills and agents text

**Files:**
- Modify: `.claude/skills/ticket-to-pr/SKILL.md`, `.claude/skills/ticket-refine/SKILL.md`, `.claude/agents/recon-agent.md`, `.claude/agents/qa-agent.md`
- Test: create `test/skills/robot-fake-env.test.ts`; keep `ticket-to-pr-install-deps.test.ts` green.

- [ ] **Step 1: Write the failing text guards:**
  - None of the four files contains `real local` or `picks up its real`.
  - ticket-to-pr and ticket-refine each contain `fake env` and `Never read <REPO_DIR>/.envrc`.
  - ticket-to-pr contains `New settings:` and `add the real INT value to your .envrc`, and matches `/setting[^.]*\.envrc\.example[^.]*bounce[^.]*env_setup/is` (the missing-setting bounce).
  - qa-agent and recon-agent each contain `fake env`.
- [ ] **Step 2:** The guards are expected to FAIL.
- [ ] **Step 3: Rewrite the passages** listed in the spec ("Skills and agents text"). Read docs/skills.md first. Also add the `New settings:` line to the PR-body template section in ticket-to-pr.
- [ ] **Step 4:** All three gates are green.
- [ ] **Step 5:** Commit `docs(skills): the robot works on the loop's fake env; new settings go to .envrc.example; missing ones bounce`.

### Task 6: Docs

**Files:** `docs/guide/how-dev-loop-works.html`, `docs/sandbox-sbx.md`, `CHANGELOG.md`, `docs/future-enhancements.md`, `docs/skills.md` (if it describes the direnv/env behaviour)

- [ ] **Step 1:** Guide changes:
  - The `.envrc` row: sbx `can("no", "sbx covers the real file; the robot gets fake values from .envrc.example")`; none `can("warn", "No, by rule only: the robot gets fake values and a rule blocks reading the file, but a shell command could still read it")`.
  - Update the `env-sub` text to match.
- [ ] **Step 2:** `docs/sandbox-sbx.md`:
  - The template step no longer asks to allow.
  - The env-file section says the files are covered and checked.
- [ ] **Step 3:** CHANGELOG: a 2.2.0 Unreleased bullet tagged `[core]` `[dev]` `[research]`.
- [ ] **Step 4:** future-enhancements:
  - the drift check, with the note to fix webtarsthree's example first;
  - sbx INT-key injection;
  - a typed env schema plus vault refs.
- [ ] **Step 5:** All three gates are green. Commit `docs: robot fake env in the guide, sbx doc, changelog and future ideas`.
