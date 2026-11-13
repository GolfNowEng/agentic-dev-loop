# sbx Sandbox Adapter Implementation Plan (2.2.0 step 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first real sandbox plug: `--sandbox=sbx` runs each `claude -p` inside a fresh Docker Sandbox, reports refusals, and always removes it.

**Architecture:** Everything sbx-specific lives in `src/sandbox/sbx/`. The adapter is built by a factory over an injectable command runner, so every test is offline. Shared code gains only adapter-neutral fixes from the spec's "Carried into step 3" list.

**Tech Stack:** Node 24, TypeScript (erasable), vitest, `sbx` v0.53.0 CLI.

**Spec:** `docs/superpowers/specs/2026-11-12-sbx-sandboxed-spawns-design.md`. Read §4.1–4.9 and §9's "Verified before step 3" and "Carried into step 3" sections.

## Global Constraints

- No `\bsbx\b` in `src/` outside `src/sandbox/sbx/` (structure test). No adapter-name branching outside `src/sandbox/`.
- dev-loop never runs `sbx policy allow`, `sbx secret set` or `sbx policy approval respond`. It prints them only.
- Nothing secret travels in argv. Env passes into the sandbox only by name (`sbx exec -e NAME`), and only allowlisted names.
- Instance names are at most 63 chars of `[a-z0-9-]`, starting and ending with alphanumerics.
- Every sbx call has a timeout. A timeout counts as a failure of that call, never a hang.
- `npm test`, `npm run test:hooks`, `npx tsc --noEmit` stay green. TDD: RED commit, then GREEN. CHANGELOG bullets tagged `[core]`.

## Review Focus

1. A lowercase-path shell (`~/Desktop/repos/...` on a case-insensitive Mac): preflight must refuse with the fix, not let every run fail with "No such file". (Task 2)
2. A long project and ticket name: the instance name must be capped at 63 and still start with the project's prefix. (Task 1)
3. sbx daemon down: every ticket would park in turn. An all-`infra` report must pause the worker after one park. (Task 3)
4. A hung `sbx create`: the run must end as an infra denial, not wait forever. (Tasks 1, 3)
5. `sbx rm` of an already-removed sandbox exits 1 "not found": teardown must treat it as done and not log a failure. (Task 2)

---

### Task 1: Instance name cap, command runner, config

**Files:**
- Modify: `src/worker/skill-runner.ts` (`sandboxInstanceName`), `test/worker/skill-runner.test.ts`
- Create: `src/sandbox/sbx/run.ts`, `src/sandbox/sbx/config.ts`, `test/sandbox/sbx/config.test.ts`, `test/sandbox/sbx/run.test.ts`

**Interfaces:**
- Produces: `type SbxResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }`; `type SbxRunner = (args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<SbxResult>`; `realSbxRunner: SbxRunner` (execFile `sbx`, never a shell, default timeout `SBX_CALL_TIMEOUT_MS = 30_000`); `interface SbxConfig { kitDir: string; memory?: string; envAllow: string[] }`; `validateSbxConfig(raw: unknown): SbxConfig`; `DEFAULT_ENV_ALLOW = ["ANTHROPIC_DEFAULT_HAIKU_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL","ANTHROPIC_DEFAULT_OPUS_MODEL","CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"]`.

- [ ] **Step 1: Failing tests.**
  - `sandboxInstanceName` with a 40-char project and ticket `ABCDEFGHIJ-123456` and role `research` gives a name of length ≤ 63 that starts with `sandboxInstancePrefix(project)`, ends with `-<shortId>`, and matches `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`.
  - `validateSbxConfig(undefined)` throws `sandbox.sbx: kitDir is required`. A relative `kitDir` throws `sandbox.sbx: kitDir must be an absolute path`. An unknown key throws `sandbox.sbx: unknown key "x"`. `memory: "4g"` passes; `memory: "lots"` throws a message containing `memory`. `envAllow` defaults to `DEFAULT_ENV_ALLOW`. A given list is appended to it, deduplicated. Any name matching `/TOKEN|SECRET|KEY|PASSWORD|AUTH/i` throws `sandbox.sbx: envAllow may not pass "<name>" (secret-shaped)`.
  - `realSbxRunner` with an injected execFile fake: it passes args verbatim with no shell, returns `timedOut: true` when the fake reports a kill on timeout, and maps a non-zero exit to `code`.
- [ ] **Step 2:** Run and see them fail. Commit RED.
- [ ] **Step 3:** Implement.
  - Cap: if the name is over 63, trim the `<ticket>-<role>` middle (never the prefix or the shortId), then strip trailing `-` before `-<shortId>`.
  - The runner takes `execFile` by injection (`makeSbxRunner(execFileImpl)`); `realSbxRunner = makeSbxRunner(node execFile)`.
- [ ] **Step 4:** Green. Commit.

### Task 2: The sbx adapter

**Files:**
- Create: `src/sandbox/sbx/adapter.ts`, `src/sandbox/sbx/index.ts` (exports `sbxAdapter = makeSbxAdapter({ run: realSbxRunner })`), `test/sandbox/sbx/adapter.test.ts`
- Modify: `test/structure.test.ts`, `src/sandbox/index.ts` (registry line `sbx: sbxAdapter`), `src/sandbox/types.ts` (`PreflightCtx` gains `instanceName: string` and `cwd: string`), `src/main.ts` (pass them: `sandboxInstancePrefix(slug) + "preflight-" + 6 hex`, cwd `REPO_ROOT`), `test/sandbox/registry.test.ts`, `test/sandbox/contract.test.ts`
- Fixture: `test/fixtures/sbx/policy-log-blocked.json` (captured, already committed)

**Interfaces:**
- Consumes: Task 1's `SbxRunner`, `SbxConfig`, `validateSbxConfig`.
- Produces: `makeSbxAdapter(deps: { run: SbxRunner; realpath?: (p: string) => string; hostNodeMajor?: number }): SandboxAdapter` with `name: "sbx"`. `CREATE_TIMEOUT_MS = 180_000`.

Behavior, one method at a time. Each one gets a test asserting the exact argv given to the fake runner:

- **prepare:** `["create","--name",N,"--no-progress","--no-input", ...(memory? ["--memory",m]:[]), "claude","--kit",kitDir, ...mounts]` with timeout `CREATE_TIMEOUT_MS`. A non-zero exit or a timeout throws `sbx create failed (<code|timeout>): <first stderr line>`. Returns `{ adapter: "sbx", instanceName: N }`. It reads its config from `run.config`.
- **wrap:** `cmd "sbx"`, args `["exec","-w",opts.cwd, ...envAllow.filter(n => n in opts.env).flatMap(n => ["-e", n]), N, cmd, ...args]`, opts unchanged. An absent cwd omits `-w`. Values never appear in args (a test asserts that no env value is a substring of any arg).
- **inspect(h, exitCode):** exit 125 gives `{kind:"infra", target:"sbx exec"}`. Then `["policy","log",N,"--json"]` (timeout default): each `blocked[].host` gives `{kind:"network", target: host}`. If the log call fails or its JSON doesn't parse, add `{kind:"infra", target:"policy log"}`; never throw. `approveHint` lists one line per unique network host without the port, `sbx policy allow network <host>`, under the heading `Review, then run yourself if you approve:`. No hint when nothing was denied.
- **teardown:** `["rm","--force",N]`. Exit 0, or stderr containing `not found`, is done. Anything else logs nothing itself and throws, so spawn-claude's existing teardown wrapper logs it. Calling twice runs `rm` twice; both resolve.
- **cleanupOrphans({prefix}):** `["ls","--json"]`, then `rm --force` each `name` that `startsWith(prefix)`, one call per name. A test with names for prefixes `dl-1-a-` and `dl-3-a-b-` removes only the first. If ls fails it throws `sbx ls failed: …`.
- **preflight(ctx):**
  1. Every `ctx.mounts` entry and `ctx.cwd` must equal `realpath(p)` (default `fs.realpathSync.native`). Otherwise throw `sandbox paths must match the disk's real case: "<p>" is "<real>" on disk; cd into the real path and restart`.
  2. `kitDir` must exist and contain a `*.yaml`. Otherwise throw `sandbox.sbx.kitDir "<dir>" has no kit yaml`.
  3. Create `ctx.instanceName` (same argv as prepare), exec `["exec",N,"sh","-c","node --version && git --version && gh auth status"]`, and always `rm --force` it in a finally.
     - A node major different from `hostNodeMajor` (default `process.versions.node` major) or a missing node: throw `sandbox image has no node <major>: add node to the kit (see docs/sandbox-sbx.md)`.
     - A `gh auth status` failure: throw `gh is not logged in inside the sandbox: run sbx secret set github (see docs/sandbox-sbx.md)`.
     - Any other failure: `sbx preflight failed: <first stderr line>`.
- **validateConfig:** `validateSbxConfig`.

- [ ] **Step 1:** Failing tests for each method above (argv, mapping from the fixture, the not-found teardown, prefix-scoped cleanup, all three preflight refusals plus the finally-rm on failure). Registry test: `adapterNames()` is `["none","sbx"]`. Contract suite: parameterize over `[noneAdapter, makeSbxAdapter({ run: fakeOk })]`. `fakeOk` answers create/rm with 0, `policy log` with `{"allowed":[],"blocked":[]}` and ls with `[]`. Add a test that every registry name has a contract entry. The contract `RUN.config` becomes adapter-specific (`{ kitDir: "/kit", envAllow: [] }` for sbx). Commit RED.
- [ ] **Step 2:** Implement and register. The structure test's sbx scan must also allow exactly one more file, `src/sandbox/index.ts` (the registry line is the one sanctioned mention). Add it as a named single-file exception with a comment, and add a test that the registry file mentions sbx only in its import and its registry line. Green. Commit.

### Task 3: Shared carry-overs (f) (g) (h) (i)

**Files:**
- Modify: `src/core/spawn-claude.ts`, `src/worker/skill-runner.ts`, `src/core/run-skill.ts`, `src/worker/cycle-steps.ts`, `src/worker/cycle.ts`, `src/core/iteration-log.ts`; tests beside each.

**Interfaces:**
- Produces: `PREPARE_TIMEOUT_MS = 300_000` and `INSPECT_TIMEOUT_MS = 60_000` (exported from spawn-claude.ts); `PhaseEntry.sandbox?: { adapter: string; instance: string; prepare_ms: number }`; `ParkedRun.sandbox?` (same shape); `RunSkillResult.parked.allInfra?: true`.

- [ ] **Step 1: Failing tests.**
  - (g) A `prepare` that never resolves returns after `PREPARE_TIMEOUT_MS` with `spawnError` `sandbox prepare failed: timed out after 300s`, an infra denial target `prepare`, and the fake spawn never called. A hung `inspect` resolves after `INSPECT_TIMEOUT_MS` with `{kind:"infra", target:"inspect"}`, then teardown runs. Use injected setTimeout fakes, as existing tests do.
  - (f) A parked result whose denials are all `infra` makes the cycle write one `parked` record, then return `{kind:"paused"}` with a reason starting `sandbox infrastructure failed:` that also names `npm run sandbox:approvals -- --clear=<KEY>`. A mixed network+infra park returns `did`, as today.
  - (h) The `PhaseEntry` and the `parked` record carry `sandbox: {adapter, instance, prepare_ms}` when the run was sandboxed, and omit the key otherwise.
  - (i) A result with `terminal_reason: "brand_new"` logs one error line containing `unknown terminal_reason "brand_new"` and `ALLOWED_TERMINAL_REASONS (src/core/spawn-claude.ts)`. Behavior is unchanged: still agent_error.
- [ ] **Step 2:** Commit RED. Implement. Green. Commit.

### Task 4: Docs and setup guide

**Files:**
- Create: `docs/sandbox-sbx.md`
- Modify: `docs/config.md` (both "Sandbox (optional)" sections: the `sandbox.sbx` keys `kitDir`, `memory`, `envAllow`), `CHANGELOG.md` (2.2.0: the sbx bullet moves from Planned to built; carry-overs f–i), the spec (Status line: step 3 built; mark carry items a–i resolved, each with a one-line pointer), `docs/skills.md` only if it mentions sandbox status.

`docs/sandbox-sbx.md` holds the user's step-4 checklist, plain and in order:
1. Kit location (`~/Desktop/Repos/keystone-bedrock-kit`) and the config block.
2. Add node to the kit. Note that a mixin's dockerfile is `FROM scratch`, so node goes in with a template (`sbx template save` from a sandbox where node was installed, then `-t`), or with a kit change; the user picks. Preflight names this doc.
3. `sbx secret set github` with a fine-grained token for the four repos.
4. A one-time credential approval.
5. Run in discover mode first, read `npm run sandbox:approvals`, and decide on the printed allow lines yourself.
6. Start from a real-case path (the case trap).
7. Atlassian MCP inside the sandbox is unverified; the discover run will show it.

- [ ] **Step 1:** Write the docs. Run `npm test` (docs-linked tests, if any), then commit.
