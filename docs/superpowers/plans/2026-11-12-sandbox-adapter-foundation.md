# Sandbox Adapter Foundation (2.2.0, rollout steps 1–2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch "exit 0 but actually failed" runs, and add the sandbox plug-in socket with its default `none` plug, the `--sandbox=` flag and config block, and a `parked` outcome. Default behavior stays byte-for-byte unchanged.

**Architecture:**
- Each `claude -p` spawn goes through a `SandboxAdapter` chosen by name from a static registry (`src/sandbox/`).
- `spawnClaudeRun` runs prepare → wrap → spawn → inspect → teardown.
- Refusals the sandbox reports travel up as `parked` on the skill result. The cycle records a phase-less `parked` iteration with `resume` set, so no attempt is counted.
- `npm run sandbox:approvals` lists parked tickets, and `--clear=<KEY>` un-parks one.
- The sbx adapter itself is NOT in this plan (rollout step 3 waits on the user's open questions).

**Tech Stack:** Node 24 (host runs 24.16; erasable TypeScript run directly), vitest, plain `.mjs` scripts. `package.json` `engines` moves to `>=24.0.0` in Task 8 (user decision 2026-11-12).

**Spec:** `docs/superpowers/specs/2026-11-12-sbx-sandboxed-spawns-design.md` (§4.1–4.6, §6, §7, §8 steps 1–2)

## Global Constraints

- Default adapter is `none`. With it, the argv, env, cwd and stdio passed to `deps.spawn` must equal today's exactly.
- The string `sbx` must not appear in any file under `src/` outside `src/sandbox/sbx/`. That folder doesn't exist yet in this plan, so `sbx` appears nowhere in `src/`.
- No `if (adapter === "<name>")` branching in shared code. Shared code talks only to the `SandboxAdapter` interface.
- New flags are `--key=value` through `parseFlags` (`src/core/flags.ts`). Booleans stay bare.
- No secret values in argv, env, logs, records, notifications. Free text in records goes through `redactSensitive` (`appendIteration` already does this for `detail`, so new string fields need it too).
- dev-loop code never runs an allow/approve command. `sandbox:approvals` only **prints** `approveHint`.
- TDD: commit RED (failing tests) before GREEN. `npm test`, `npm run test:hooks`, `npx tsc --noEmit` green after every task.
- Read `docs/config.md` before touching `src/core/config.ts` / `Config` in `src/core/types.ts`. Update it in the same task.
- Every CHANGELOG bullet is tagged `[core]`/`[research]`/`[dev]`/`[hooks]` under the existing `## [Unreleased — 2.2.0] — planned` heading. Don't bump `package.json` in this plan (2.2.0 ships with the sbx adapter).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`. Never push.
- Work on branch `feat/sandbox-adapter` off local `main`.

## Review Focus

1. **A result line with `is_error: false` but no `terminal_reason`** (older CLI). Accept it as success. Only an explicit non-allowed value, `is_error: true`, or no result fails it. Pinned in Task 1.
2. **`prepare` throws** (the sandbox can't start). This must become an `infra` denial that parks the ticket. It must not throw out of `spawnClaudeRun` (which "never throws"), and spawn must never be called. Pinned in Task 3.
3. **A signal arrives mid-run under an adapter.** `killActiveChild` must call `teardown` exactly once, even though the `finally` also runs it (idempotent). Pinned in Task 3.
4. **A parked ticket is still in the dev poll** (status In Progress, dev label). Without an explicit exclude the loop re-runs it every iteration. Exclusion and pendingResumes skipping it are both pinned in Task 6.
5. **`--clear=<KEY>` for a ticket that isn't parked, or while a loop is running.** The script refuses a non-parked key with a message. The append is one `appendFile` line, the same as the loop's, so it's safe concurrently. Pinned in Task 7.

---

### Task 1: Result-error detection (spec §4.5)

**Files:**
- Modify: `src/core/spawn-claude.ts` (`SpawnClaudeResult`; tail of `spawnClaudeRun`)
- Test: `test/core/spawn-claude.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `SpawnClaudeResult.resultError?: { is_error: boolean; terminal_reason?: string }`, and an exported `ALLOWED_TERMINAL_REASONS: readonly string[] = ["completed"]`.
- When the exit was 0 and not killed, but the parsed final result fails the check, the result also carries `spawnError` (text below). The existing `devEarlySkillResult` / `researchEarlySkillResult` then record it as `agent_error` with no other change.

Ruling (spec says "capture the real values, don't guess"): every local `usage.json` from real runs (4 found) has `type:"result", subtype:"success", is_error:false, terminal_reason:"completed"`, and the spike's stall had `terminal_reason:"api_error"`. So the allowed set is `["completed"]`. An absent `terminal_reason` with `is_error:false` passes (Review Focus 1).

- [ ] **Step 1: Write failing tests** in a new `describe("result-error detection")`, using the existing fake-child helpers (`child.finish(stdout, 0)`):
  - `{type:"result", is_error:false, terminal_reason:"completed", total_cost_usd:0.5}`: no `spawnError`, and `resultError` equals `{ is_error:false, terminal_reason:"completed" }`.
  - `{type:"result", is_error:false, terminal_reason:"api_error", total_cost_usd:0.2}`: `spawnError` equals `claude reported a failed result (is_error=false, terminal_reason=api_error)`. Usage cost is still `0.2`.
  - `{type:"result", is_error:true, terminal_reason:"completed"}`: `spawnError` contains `is_error=true`.
  - `{type:"result", is_error:false}` (no terminal_reason): no `spawnError`.
  - Non-JSON stdout with exit 0: `spawnError` equals `claude exited 0 without a result`.
  - Streaming: final line `{type:"result", is_error:false, terminal_reason:"api_error"}` gets the same spawnError as the non-streaming case.
  - A nonzero exit keeps its existing `claude exited with code …` spawnError (not overwritten).
- [ ] **Step 2:** `npx vitest run test/core/spawn-claude.test.ts`. Expect the new tests to FAIL. Commit RED: `test(core): a 0 exit with a failed or missing result is an agent_error (RED)`.
- [ ] **Step 3: Implement** in `spawnClaudeRun` after `usageRaw` is parsed. The check runs only when `outcome.spawnError === undefined && !outcome.killedTimeout`.
  - Fail if any of these holds:
    - the parsed value isn't an object with `type === "result"`, giving `claude exited 0 without a result`
    - `is_error === true`
    - `terminal_reason` is a string not in `ALLOWED_TERMINAL_REASONS`
  - Log the failure via `deps.logError` like the existing spawn-failed line.
  - Set `resultError` whenever a result object was parsed.
  - Update the header comment's "a nonzero exit" sentence to include this case.
- [ ] **Step 4:** Run `npm test && npm run test:hooks && npx tsc --noEmit`. Everything must pass, and the existing dev/research early-result tests must not change.
- [ ] **Step 5:** Add this CHANGELOG bullet under Unreleased: `[core] A claude -p run that exits 0 but reports a failed result (is_error, a terminal_reason other than "completed", or no result at all) is now an agent_error instead of a silent success.` Commit GREEN: `feat(core): detect failed results behind a 0 exit (GREEN)`.

### Task 2: The adapter interface, the `none` adapter, the registry and the contract suite (spec §4.1, §7)

**Files:**
- Create: `src/sandbox/types.ts`, `src/sandbox/none.ts`, `src/sandbox/index.ts`
- Test: `test/sandbox/contract.test.ts`, `test/sandbox/registry.test.ts`

**Interfaces (Produces, used by Tasks 3–7):**
```ts
// src/sandbox/types.ts
export type SandboxMode = "discover" | "enforce";
export interface PreflightCtx { repoRoot: string; mounts: string[]; config: unknown }
export interface RunSandboxSpec { instanceName: string; mounts: string[]; config: unknown }
export interface SandboxHandle { adapter: string; instanceName: string }
export interface WrappedSpawn { cmd: string; args: string[]; opts: SpawnOptions & { env: NodeJS.ProcessEnv } }
export interface SandboxDenial { kind: "network" | "credential" | "infra"; target: string }
export interface SandboxReport { denied: SandboxDenial[]; approveHint?: string }
export interface SandboxAdapter {
  readonly name: string;
  /** Validate and normalize this adapter's own config sub-block (undefined when absent). Throws Error with a fix-naming message. */
  validateConfig(raw: unknown): unknown;
  preflight(ctx: PreflightCtx): Promise<void>;
  cleanupOrphans(): Promise<void>;
  prepare(run: RunSandboxSpec): Promise<SandboxHandle>;
  wrap(h: SandboxHandle, cmd: string, args: string[], opts: WrappedSpawn["opts"]): WrappedSpawn;
  inspect(h: SandboxHandle, exitCode: number | null): Promise<SandboxReport>;
  /** Idempotent; never throws. */
  teardown(h: SandboxHandle): Promise<void>;
}
// src/sandbox/index.ts
export const ADAPTERS: Readonly<Record<string, SandboxAdapter>>; // { none: noneAdapter }
export const DEFAULT_ADAPTER = "none";
export function adapterNames(): string[];
/** Throws Error(`unknown sandbox adapter "<name>"; valid: none`) listing adapterNames() comma-joined. */
export function getAdapter(name: string): SandboxAdapter;
```
Ruling: `validateConfig` is added to the spec's interface. Spec §4.3 has each adapter validate its own sub-block, and this is where that lives, so `config.ts` never learns adapter keys.

- [ ] **Step 1: Write the contract suite first.** Use `describe.each(Object.values(ADAPTERS))`, so a future adapter is tested the moment it's registered. Name the cases exactly:
  - `prepare returns a handle naming this adapter and the instance`
  - `wrap preserves the claude args in order`: the wrapped `args` contains the input args as a contiguous, in-order subsequence.
  - `wrap never adds an env key whose value is not in the input env`: no new secret values.
  - `inspect returns a SandboxReport with a denied array`
  - `teardown is idempotent and never throws`: call it twice and both resolve.
  - `validateConfig(undefined) does not throw`
  - In a separate `describe("none adapter")`: `wrap returns cmd/args/opts unchanged` (using `toBe` identity on args and opts), and `inspect reports nothing denied` (`{ denied: [] }`).
- [ ] **Step 2: Registry tests.** `getAdapter("none") === noneAdapter`. `getAdapter("bogus")` throws `unknown sandbox adapter "bogus"; valid: none`. `DEFAULT_ADAPTER` is `"none"`.
- [ ] **Step 3:** Run, expect FAIL (modules missing). Commit RED.
- [ ] **Step 4: Implement** the three files. `none.ts`: every method is a no-op, `prepare` returns `{ adapter: "none", instanceName: run.instanceName }`, and `validateConfig` returns its input. Put a header comment in `types.ts` with the socket/plug analogy from spec §1, plus "removing an adapter = delete its folder + its registry line".
- [ ] **Step 5:** All three checks green. Commit GREEN: `feat(core): sandbox adapter interface, none adapter, registry, contract suite (GREEN)`.

### Task 3: Plug the adapter into `spawnClaudeRun` (spec §4.2, §6)

**Files:**
- Modify: `src/core/spawn-claude.ts` (`SpawnClaudeOpts`, `SpawnClaudeResult`, `runChild`, `killActiveChild`, `active`)
- Test: `test/core/spawn-claude.test.ts`

**Interfaces:**
- Consumes: Task 2 types.
- Produces:
  ```ts
  // SpawnClaudeOpts
  sandbox?: { adapter: SandboxAdapter; run: RunSandboxSpec };
  // SpawnClaudeResult
  sandbox?: { adapter: string; instance: string; prepare_ms: number; report: SandboxReport };
  ```
  With `opts.sandbox` absent, nothing changes and `result.sandbox` stays absent.

Behavior:
1. `prepare` is timed with `deps.now()` to give `prepare_ms`.
2. `wrap(handle, "claude", buildArgs(opts), <today's exact opts object>)` produces the `deps.spawn` call.
3. After the child settles, `inspect(handle, exitCode)` runs. Thread the close code out of `runChild`, or `null` when killed or on error.
4. `teardown` runs in a `finally`.
5. The `active` record also carries `teardown: () => Promise<void>`:
   - `killActiveChild` awaits it after the child is gone (both the `exited` and `killed` paths).
   - The timeout path calls it (fire-and-forget) right after its SIGKILL.
   - Teardown is once-guarded inside spawn-claude, so the `finally` plus a kill call it only once.
6. If `prepare` throws, don't spawn. Return `spawnError: "sandbox prepare failed: <message>"`, zero usage, and `sandbox.report = { denied: [{ kind: "infra", target: "prepare" }] }`. Teardown is not called (there's no handle).
7. An `inspect` that throws becomes `{ denied: [{ kind: "infra", target: "inspect" }] }` and is never rethrown.

- [ ] **Step 1: Write failing tests**, using a recording fake adapter (calls pushed to an array, configurable `inspect` result):
  - `with no sandbox option, the spawn call is unchanged`: argv, cmd `"claude"` and the opts keys equal a snapshot taken without the field.
  - `with the none adapter, deps.spawn gets exactly the same cmd/args/opts as without a sandbox` (spec §7's pin).
  - `calls prepare, wrap, spawn, inspect, teardown in order on success`
  - `spawns the wrapped command, not claude`: the fake wrap returns `{cmd:"wrapper", args:["run","--","claude",...args]}`.
  - `tears down on a nonzero exit, a spawn() throw, and a child 'error' event`: three cases.
  - `tears down on a timeout kill`: manual timers from the existing timeout tests.
  - `killActiveChild tears down exactly once`: kill mid-run, then let the run finish. The teardown count must be 1.
  - `prepare throwing never spawns and reports an infra denial` (Review Focus 2).
  - `inspect throwing becomes an infra denial, not a throw`
  - `result.sandbox carries adapter, instance, prepare_ms and the report`
- [ ] **Step 2:** Run, expect FAIL. Commit RED.
- [ ] **Step 3: Implement.** Keep `buildArgs` unchanged. Add one sentence about the adapter step order to the file header.
- [ ] **Step 4:** All three checks green. The existing spawn tests must be untouched.
- [ ] **Step 5:** Commit GREEN: `feat(core): spawnClaudeRun runs every spawn through an optional sandbox adapter (GREEN)`.

### Task 4: Config block and the `--sandbox=` flag (spec §4.3)

**Files:**
- Modify: `src/core/types.ts` (`Config.sandbox?`), `src/core/config.ts` (root `keys(...)` at line 123, plus a new `sandbox` validator), `src/core/cli-args.ts`, `src/main.ts` (usage comment line 3)
- Create: `src/sandbox/select.ts`
- Test: `test/core/config.test.ts`, `test/core/cli-args.test.ts`, `test/sandbox/select.test.ts`
- Docs: `docs/config.md` (a `### Sandbox (optional)` subsection in both the Research and Dev phase sections, which may cross-reference each other), `CHANGELOG.md`

**Interfaces:**
- `Config.sandbox?: SandboxConfig`, where `SandboxConfig = { adapter: string; mode?: SandboxMode; [adapterName: string]: unknown }`, defined in `src/sandbox/types.ts` and imported by `types.ts`.
- `CliArgs.sandbox?: string` (from `--sandbox=<name>`).
- `src/sandbox/select.ts`:
  ```ts
  export interface SandboxSelection { adapter: SandboxAdapter; mode: SandboxMode; config: unknown }
  /** cliName wins over config.sandbox.adapter; neither gives the none adapter. mode defaults to "enforce". */
  export function selectSandbox(config: Config, cliName: string | undefined): SandboxSelection;
  ```

Validation (in `config.ts`, error text exact):
- `sandbox` must be an object. Allowed keys are `adapter`, `mode`, plus any name in `adapterNames()`. An unknown key gives `sandbox: unknown key "<k>" (allowed: adapter, mode, <names>)`, matching the existing `keys()` helper's wording if it already has one. Reuse `keys()`.
- `adapter`: a string naming a registered adapter. Otherwise give `getAdapter`'s message prefixed with `sandbox.adapter: `.
- `mode`: absent, `"discover"` or `"enforce"`. Otherwise: `sandbox.mode must be "discover" or "enforce" (got "<v>")`.
- The selected adapter's own sub-block `sandbox[<adapter>]` goes through `adapter.validateConfig`. Its error is prefixed `sandbox.<adapter>: `.
- `selectSandbox` with an unknown `cliName` throws the `getAdapter` message prefixed `--sandbox: `. main.ts surfaces this before acquiring the session (call `selectSandbox` right after `preflight(...)`).

- [ ] **Step 1: Write failing tests:**
  - config: absent `sandbox` is valid; `{adapter:"none"}` is valid; `{adapter:"none", mode:"discover"}` is valid; `{adapter:"bogus"}` is rejected; `{adapter:"none", mode:"loud"}` is rejected; `{adapter:"none", kitDir:"/x"}` is rejected as an unknown key.
  - cli-args: `--sandbox=none` gives `sandbox: "none"`; absent gives `undefined`; `--sandbox none` throws `use --sandbox=none`.
  - select:
    - no config + no cli gives the none adapter in mode `enforce`
    - config `{adapter:"none", mode:"discover"}` gives mode discover
    - `cliName "none"` overrides a config adapter (use a test-only registered fake via a `getAdapter` seam, or assert against `none` only, implementer's call)
    - an unknown cliName throws `--sandbox: unknown sandbox adapter "x"; valid: none`
- [ ] **Step 2:** Run, expect FAIL. Commit RED.
- [ ] **Step 3: Implement.** In docs/config.md: the block, CLI precedence, `--sandbox=none` as the per-run off switch, and "an adapter's own sub-block is keyed by its name and validated by that adapter".
- [ ] **Step 4:** All three checks green.
- [ ] **Step 5:** CHANGELOG: `[core] Optional "sandbox" config block and --sandbox=<name> flag (CLI wins; --sandbox=none forces it off). Only the none adapter exists so far; the default is unchanged.` Commit GREEN.

### Task 5: The skill runner computes mounts and the instance name, and maps denials to `parked` (spec §4.4, §4.6 triggers)

**Files:**
- Modify: `src/worker/skill-runner.ts`, `src/core/run-skill.ts`, `src/main.ts` (pass the selection into `makeRunSkill`, plus `adapter.preflight` / `cleanupOrphans` once at startup)
- Test: `test/worker/skill-runner.test.ts`

**Interfaces:**
- Consumes: `SandboxSelection` (Task 4), `SpawnClaudeOpts.sandbox` / `SpawnClaudeResult.sandbox` (Task 3).
- `SkillRunnerDeps.sandbox?: SandboxSelection`. Absent means no `sandbox` field on spawn opts at all (keeps Task 3's no-op path).
- `RunSkillResult.parked?: { denied: SandboxDenial[]; approveHint?: string }`
- Exported for tests: `sandboxInstanceName(ticketKey: string, role: Role, shortId: string): string`. It returns `dl-<ticket lowercased>-<role>-<shortId>`, e.g. `dl-tars-1-dev-a1b2c3`. `shortId` is 6 lowercase hex chars from `randomBytes(3)`, injectable via `SkillRunnerDeps.shortId?: () => string`.
- Exported for tests: `sandboxMounts(repoRoot: string, repoDir: string): string[]`. It returns `[repoRoot, repoDir]`, deduplicated, and drops `repoDir` when it's inside `repoRoot` (the v2 clone case). Ruling: the per-run worktree is created by the skill inside `repoDir`, so mounting `repoDir` (spec mount 2) covers mount 3. No separate worktree mount until a case shows one outside it.

Behavior:
- If `run.sandbox.report.denied` is non-empty and mode is `enforce`, return early **before reading verdict.json** with:
  - `verdictRaw: undefined`
  - `parked: { denied, approveHint }`
  - measured cost/tokens and started/ended
  - and log `[<skill>] <KEY>: sandbox refused <kind> <target>, ...; parking`.
- In `discover` mode, log the same line with `; discover mode, not parking` and carry on normally.
- When a sandbox is attached, the existing "running" log line names the instance so it can be matched to a row in the sandbox's own dashboard: `[<skill>] <KEY>: running in <instanceName> (run dir <runDir>, budget $<n>)...`. Without one, the line is unchanged. (User-approved 2026-11-12.) Test: `the running line names the sandbox instance only when a sandbox is attached`.
- The parked check runs before `researchEarlySkillResult` / `devEarlySkillResult`, because a prepare failure also sets spawnError and it must park, not error.
- main.ts startup: after `selectSandbox`, run `await sel.adapter.preflight({ repoRoot: REPO_ROOT, mounts: sandboxMounts(REPO_ROOT, repoDir), config: sel.config })` and then `await sel.adapter.cleanupOrphans()`, before `acquireSession`. A throw exits 1 through the existing fatal path. Pass `sandbox: sel` into `makeRunSkill` only when `sel.adapter.name !== DEFAULT_ADAPTER`. This is a comparison against the registry constant, not an adapter name, and it keeps `none` byte-identical by not attaching it at all.

- [ ] **Step 1: Write failing tests:**
  - `sandboxInstanceName("TARS-12","dev","a1b2c3")` gives `dl-tars-12-dev-a1b2c3`.
  - `sandboxMounts`: an outside checkout gives both paths; an inside clone gives only the root; the same path twice gives one.
  - Without `deps.sandbox`, spawn opts have no `sandbox` key.
  - With a fake selection, spawn opts carry `{adapter, run:{instanceName, mounts, config}}`.
  - Enforce plus a denied report gives `parked` set, `verdictRaw` undefined, and verdict.json **not read** even when the test wrote one into the run dir.
  - Discover plus a denied report reads verdict.json normally, with no `parked`.
  - Enforce plus a prepare-failure result (spawnError plus infra denial) gives `parked`, not the agent_error early result.
- [ ] **Step 2:** Run, expect FAIL. Commit RED.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** All three checks green.
- [ ] **Step 5:** Commit GREEN: `feat(core): skill runner passes the sandbox per run and parks on refusals (GREEN)`.

### Task 6: The `parked` outcome and `sandbox_denied`, end to end in the cycle (spec §4.6 behavior, §6)

**Files:**
- Modify: `src/core/types.ts` (`FailureCategory` adds `"sandbox_denied"`), `src/core/iteration-log.ts` (outcomes plus the record field), `src/worker/cycle-steps.ts` (`runPhase`), `src/worker/cycle.ts` (`devOnly`, `researchThenDev`, `iterate` step 2), `src/worker/recover.ts` (`pendingResumes`), `src/worker/context.ts` (`WorkerDeps.notify?`), `scripts/stats.mjs`, `src/main.ts` (wire `notify`)
- Create: `src/core/notify.ts`
- Test: `test/worker/cycle.test.ts`, `test/core/iteration-log.test.ts`, `test/scripts/stats.test.ts`, `test/core/notify.test.ts`
- Docs: `docs/logging.md`, `docs/superpowers/specs/2026-11-10-dev-loop-v2-design.md` (failure_category enum list: add `sandbox_denied`), `CHANGELOG.md`

**Interfaces:**
- `IterationOutcome` adds two values:
  - `"parked"`: a phase run the sandbox refused (phases: [], resume set, not an attempt; the poll skips it until cleared).
  - `"unparked"`: written by `sandbox:approvals --clear` (phases: [], resume copied from the park, so it re-runs).
- `IterationRecord.parked?: { role: Role; failure_category: "sandbox_denied"; denied: SandboxDenial[]; approveHint?: string; cost_usd: number; run_dir: string }`. `appendIteration` redacts `approveHint` and each `target`.
- `PhaseRun` (cycle-steps) gains `parked?: RunSkillResult["parked"] & { cost_usd: number; run_dir: string }`. `runPhase` wraps `deps.runSkill` to capture `parked` from the result. The phase functions stay unchanged: with `verdictRaw` undefined they produce an agent_error entry and make no Jira write. When `parked` is set, the caller ignores that entry.
- `src/core/notify.ts`: `export function notify(title: string, body: string, exec?: ExecFileFn): void`. On darwin it runs `osascript -e 'display notification "<body>" with title "<title>"'` with `"` and `\` escaped and both strings passed through `redactSensitive`. It's fire-and-forget, never throws, and does nothing on other platforms.
- `WorkerDeps.notify?: (title: string, body: string) => void`

Behavior:
- In `devOnly` / `researchThenDev`, when `run.parked` is set: `append(ctx, key, started, "parked", priorPhases, { resume: role, detail: "sandbox refused: <kind> <target>, ...", parked: {...} })`.
  - `priorPhases` is `[]`, or in researchThenDev the handed-off research phase when dev was the one parked. Research landed and its cost is real.
  - Then `deps.notify?.("dev-loop: <KEY> parked", "sandbox refused <targets>; run npm run sandbox:approvals")`.
  - Return `{ kind: "did", record }`. The loop continues.
  - Extend `append`'s `extra` Pick with `"parked"`.
- `iterate` step 2: add every ticket whose `latestRecord` outcome is `parked` to `ctx.exclude`.
- `pendingResumes`: skip a ticket whose latest record is `parked`.
- `failedAttempts`: unchanged. The parked record has no phase for that role, so it isn't counted. A test pins this.
- stats.mjs v2: after the two role lines, print `  parked: <n> ticket(s) currently parked` when n > 0 (latest record per ticket is `parked`, not windowed). Phase tallies are unchanged.

- [ ] **Step 1: Write failing tests:**
  - cycle (existing fake-deps helpers, with a runSkill returning `parked`):
    - `a parked dev run appends one parked record with resume dev and no phases, and notifies`
    - `a parked dev after a landed research keeps the research phase in the parked record`
    - `a parked research run appends parked with resume research`
    - `a parked ticket is excluded from the next iteration's poll and not resumed` (Review Focus 4)
    - `a parked run makes no Jira transition or comment`
  - iteration-log:
    - `failedAttempts ignores parked records`
    - `appendIteration redacts parked.approveHint and denial targets`
  - stats: a fixture log with one parked ticket prints `parked: 1 ticket(s) currently parked`.
  - notify:
    - builds the expected osascript argv with escaped quotes
    - is a no-op when the platform isn't darwin (inject `platform`)
    - swallows an exec error
- [ ] **Step 2:** Run, expect FAIL. Commit RED.
- [ ] **Step 3: Implement.** Wire `notify` in main.ts `WorkerDeps`. Update the outcome list in docs/logging.md and the enum list in the v2 design doc.
- [ ] **Step 4:** All three checks green.
- [ ] **Step 5:** CHANGELOG: `[core] New iteration outcome "parked" (failure_category sandbox_denied): a run the sandbox refused is held without counting an attempt or touching Jira, skipped by the poll, and announced by a desktop notification.` Commit GREEN.

### Task 7: `npm run sandbox:approvals` (spec §4.6 un-parking)

**Files:**
- Create: `scripts/sandbox-approvals.mjs`
- Modify: `package.json` (`"sandbox:approvals": "node scripts/sandbox-approvals.mjs"`), `docs/logging.md` (or `docs/reset.md`'s neighbour; implementer's call: a short "Parked tickets" section in logging.md), `README.md` (one line in the commands list if one exists), `CHANGELOG.md`
- Test: `test/scripts/sandbox-approvals.test.ts` (same style as `test/scripts/stats.test.ts`: spawn the script against a temp `--root`)

**Interfaces:**
- Flags (parseFlags, prog `sandbox:approvals`): values `--project` (default `webtarsthree`, must match `/^[a-z0-9-]+$/`), `--root`, `--clear`. No bools.
- It reads `runs/v2/<project>.jsonl` under root with `readIterations` (import `../src/core/iteration-log.ts`), and appends with `appendIteration`.

Output (exact):
- No parked tickets: `No parked tickets in <path>.`
- Each parked ticket (latest record `parked`), in log order:
  ```
  <KEY> (<role>, parked <ended>):
    refused: <kind> <target>
    ...
    to allow (run these yourself): <approveHint>      # line omitted when no hint
    then: npm run sandbox:approvals -- --clear=<KEY>
  ```
- `--clear=<KEY>`:
  - If KEY isn't currently parked, print `<KEY> is not parked (latest outcome: <outcome|none>).` and exit 1.
  - Otherwise append `{ ticket: KEY, session: "approvals", loop_version: <package.json version>, started: now, ended: now, outcome: "unparked", phases: [], resume: <parked.role>, detail: "cleared by sandbox:approvals" }`, print `<KEY>: unparked; the next loop iteration resumes its <role> phase.`, and exit 0.
- It never runs any command from `approveHint`.

- [ ] **Step 1: Write failing tests:**
  - an empty log prints the no-parked line
  - one parked plus one landed ticket lists only the parked one with its targets and hint
  - `--clear` on the parked key appends the unparked record, and a following `readIterations` shows `latest.outcome === "unparked"` with `resume` equal to the role
  - `--clear` on a non-parked key exits 1 with the message (Review Focus 5)
  - `--clear KEY` (space form) exits 1 with `use --clear=KEY`
  - the script source contains no `child_process` import (it prints, never runs)
  - a cycle test (in `test/worker/cycle.test.ts`): after an `unparked` record, `pendingResumes` returns the ticket and the next iteration resumes it
- [ ] **Step 2:** Run, expect FAIL. Commit RED.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** All three checks green.
- [ ] **Step 5:** CHANGELOG: `[core] npm run sandbox:approvals lists parked tickets with what was refused and the adapter's allow hint (printed, never run); --clear=<KEY> un-parks one.` Commit GREEN.

### Task 8: Coupling guard, and the docs wrap-up

**Files:**
- Modify: `test/structure.test.ts`
- Modify: `docs/superpowers/specs/2026-11-12-sbx-sandboxed-spawns-design.md` (Status line: `Steps 1–2 built (plan 2026-11-12-sandbox-adapter-foundation.md); step 3+ pending the open user questions.` Record the Task 1 allowed-set ruling, the `validateConfig` addition and the mounts ruling in §9 as resolved).

- [ ] **Step 1: Add the structure test** `structure: no sandbox-specific names outside src/sandbox/<adapter>/`:
  - Walk `src/`, skipping `src/sandbox/sbx/`, and assert no file matches `/\bsbx\b/i`.
  - Also assert no file outside `src/sandbox/` contains `adapter === "` or `adapter.name === "`.
  - Run it; it must PASS immediately (it guards and is not RED). Confirm it fails when a temp line `// sbx` is added to `src/core/flags.ts`, then remove that line.
- [ ] **Step 1b: Node 24 floor.** Add the structure test `package.json engines.node is ">=24.0.0"` and run it (expect FAIL). Set `"engines": { "node": ">=24.0.0" }` and run it again (expect PASS). Change any `22.18` mention in README.md or docs to Node 24 (`grep -rn "22\.18" README.md docs CLAUDE.md`, ignoring dated specs and `docs/changelog/`). CHANGELOG: `[core] Node 24 is now the minimum (engines >=24.0.0); a sandbox's node must match the host's major version (spec §4.8).`
- [ ] **Step 2:** Update the spec status as above.
- [ ] **Step 3:** Run `npm test && npm run test:hooks && npx tsc --noEmit`. Expect all green, with the count above 951.
- [ ] **Step 4:** Commit: `test(structure): sandbox names stay inside their adapter folder; spec status`.
