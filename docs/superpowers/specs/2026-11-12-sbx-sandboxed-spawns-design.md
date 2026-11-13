# Sandboxed agent spawns: a pluggable sandbox adapter (first adapter: sbx)

Status: Steps 1–2 built (plan 2026-11-12-sandbox-adapter-foundation.md); step 3 built (sbx adapter, not yet dogfooded); step 4 (user setup) and later pending.
Date: 2026-11-12. It builds on the sbx spike (same day) and the 2.0.0 design
(`2026-11-10-dev-loop-v2-design.md`, §7 claim, §8 batch).

## 1. Intent

Today every `claude -p` the loop launches runs directly on the Mac, under
the user's account. It can read anything the user can read, and the
safety hooks are pattern filters with known leftover bypasses. We want each
agent run to be able to go inside a sandbox. A sandbox sees only the
folders we hand it, reaches only the network hosts on a list, and has
credentials injected by a proxy, so the agent never sees the real token.

Analogy: today the contractor has a key to the whole house and promises to
stay in the kitchen. Sandboxing puts them in a locked workshop with only
the kitchen cabinets moved in, and every delivery goes through a front
desk that checks a list.

**The sandbox is a plug-in, not a rewrite.** The loop talks to a small
"sandbox adapter" interface. Docker Sandboxes (`sbx`) is the first adapter.
If another sandbox becomes the standard (Apple containers, a cloud
sandbox, plain Docker, a company-mandated tool), you add a second
adapter file and nothing else in the loop changes. Turning it off is a flag.
Removing it entirely is deleting one folder.

Analogy: a wall socket and plugs. The loop is the socket. sbx is one plug.
A different sandbox is a different plug in the same socket. No plug is
the default, and the house works exactly as it does today.

**Option B (decided):** the loop itself (Node, the Jira REST token, logs,
the lockfile) stays on the host. Only the spawn goes through the adapter.

## 2. Goals / non-goals / anti-goals

Goals
- **Opt in per run or per project.** `--sandbox=<name>` on the CLI, or
  `"sandbox": { "adapter": "<name>" }` in project config, with the CLI
  winning. `--sandbox=none` forces it off for one run. The default is
  `none`, which produces byte-for-byte today's argv and behavior.
- **Easy to remove.** Everything sbx-specific lives under
  `src/sandbox/sbx/`. Deleting that folder plus its one line in the
  registry leaves a working loop. No sbx names leak into the worker,
  cycle, iteration-log or config code.
- **Easy to replace.** A new sandbox is one new adapter that implements
  the interface in §4.1 and passes the shared adapter contract test suite
  (§7).
- Blocked network or credential problems **park** the ticket without
  counting an attempt, and tell the user what to approve. This works the
  same way for every adapter.
- Parallel-ready: each run gets its own sandbox instance and mounts, so N
  loops on one repo (once the §7 claim exists) need nothing more here.

Non-goals
- The §7 atomic dev-claim / N workers per project. That is a separate
  prerequisite (§5).
- A general plugin system with dynamic loading or third-party packages.
  Adapters are in-repo modules picked by name from a static registry.
  That's enough to swap and remove, and doesn't add a dependency.
- Moving the loop itself into a sandbox (Option A, rejected).
- Replacing the hooks. They stay as a second layer inside any sandbox.

Anti-goals (a failure even if it "works")
- A silent stall: a run blocked on a host or an unapproved credential
  that reports success. (The spike saw this: 186 s, then exit 0 with
  `terminal_reason: api_error`.)
- sbx concepts leaking into shared code: an `if (adapter === "sbx")`
  anywhere outside `src/sandbox/sbx/`, or an `sbx` key in shared types.
- Any secret value appearing in argv, env passed to the sandbox, logs,
  progress files, Jira comments or PRs.
- Code that widens a sandbox's network allowlist. Every grant is the user
  acting from their own shell.

## 3. What the sbx spike established (sbx v0.53.0)

- `sbx exec <sb> claude -p … --output-format json|stream-json` works
  headless. stdout streams through and the exit code passes through
  (125 means sbx itself failed, 127 means command not found).
- A cold `create` takes about 26 s; with the template cached it takes
  about 4 s.
- Files the agent writes in a mounted folder appear on the host
  immediately.
- A blocked host gets HTTP 403 with the body "Approval required for
  host:443 … sbx policy approval ls". It is also visible in
  `sbx policy log --json`.
- The kit credential needs a **one-time interactive approval**
  (`sbx run`, then "1. Approve all"). Run headless, the prompt defaults to
  No and the token is silently absent.
- A worktree mounted alone is broken, because its `.git` file points into
  `<main>/.git/worktrees/`. Mounting the main repo as well works. Two
  sandboxes made 40 concurrent commits to one repo and `git fsck` came
  back clean.
- The image has git, gh and claude 2.1.322, but **no node**.
- Memory defaults to 50 % of the host per sandbox. This 48 GB / 12-CPU
  Mac fits about 3–4 sandboxes at 4–6 GB each.

## 4. Design

### 4.1 The adapter interface (`src/sandbox/types.ts`)

The shared code knows only this shape, written here as intent. The
builder finalizes the exact TypeScript.

```ts
interface SandboxAdapter {
  name: string;                       // "none" | "sbx" | future
  /** Once at loop start. Throws a plain, fix-naming message on failure. */
  preflight(ctx: PreflightCtx): Promise<void>;
  /** Once at loop start, after the session lock: remove instances a previous
   *  crash left behind, only those whose name starts with scope.prefix
   *  (`dl-<len>-<project>-`). */
  cleanupOrphans(scope: { prefix: string }): Promise<void>;
  /** Per run, before spawn: create the instance with these mounts. */
  prepare(run: RunSandboxSpec): Promise<SandboxHandle>;
  /** Turn today's (command, args, options) into what actually gets spawned. */
  wrap(h: SandboxHandle, cmd: string, args: string[], opts: SpawnOptions): WrappedSpawn;
  /** Per run, after exit: anything the sandbox refused during this run. */
  inspect(h: SandboxHandle, exitCode: number | null): Promise<SandboxReport>;
  /** Per run, always (finally, timeout, signal): destroy the instance. Idempotent. */
  teardown(h: SandboxHandle): Promise<void>;
}

interface RunSandboxSpec {
  instanceName: string;   // unique per run: dl-<len>-<project>-<ticket>-<role>-<shortid>, [a-z0-9-]
  mounts: string[];       // absolute host paths, see 4.4
  config: unknown;        // the adapter's own config sub-block, validated by the adapter
}

interface SandboxReport {
  denied: { kind: "network" | "credential" | "infra"; target: string }[];
  approveHint?: string;   // human-readable "how to fix", e.g. the commands to run
}
```

- **`none` adapter** (`src/sandbox/none.ts`): every method is a no-op,
  and `wrap` returns its inputs unchanged. It is the default. This is the
  "no sandbox" path, and it is how the existing tests keep passing
  untouched.
- **`sbx` adapter** (`src/sandbox/sbx/`): `prepare` = `sbx create`,
  `wrap` = `sbx exec <name> claude …`, `inspect` = `policy log` +
  `approval ls` + exit 125, `teardown` = `sbx rm --force`, and
  `cleanupOrphans` = remove every instance starting with the given
  `dl-<len>-<project>-` prefix. This is the only place sbx
  commands, flags and output formats are known.
- **Registry** (`src/sandbox/index.ts`):
  `{ none: noneAdapter, sbx: sbxAdapter }`. An unknown name fails at
  startup with the list of valid names.

The interface is shaped by what any sandbox needs: create with mounts, run
a command inside, report refusals, destroy. Nothing in it is sbx
vocabulary. Adding a future adapter that needs something new means
extending the interface deliberately, not special-casing.

### 4.2 Where it plugs in

`spawnClaudeRun` (`src/core/spawn-claude.ts`) gets the adapter through its
existing `deps`. The order:
1. `prepare`
2. `wrap` → `deps.spawn(wrapped.cmd, wrapped.args, wrapped.opts)` at the
   current spawn site (today `deps.spawn("claude", buildArgs(opts), …)`,
   around line 419)
3. `inspect`
4. `teardown` in a `finally`

`buildArgs` is unchanged. The adapter wraps it. The timeout path and
`killActiveChild` (the SIGINT/SIGTERM handler) also call `teardown`,
because killing a wrapper process doesn't reliably stop what runs inside
a VM. Today's timeout sends SIGTERM to the child only (`child.kill`, line
~458, not a process group). That stays as-is for `none`.

Env: `childEnv` keeps stripping the Jira keys. The sbx adapter passes
**no host env** into the sandbox except an explicit, non-secret
allowlist the adapter declares (e.g. the `ANTHROPIC_DEFAULT_*_MODEL`
names, if the kit doesn't set them; verify during discovery).
Credentials enter only through the sandbox's own secret store.

### 4.3 Selecting and configuring

```jsonc
// project config, optional; absent == { "adapter": "none" }
"sandbox": {
  "adapter": "sbx",
  "mode": "enforce",                 // "discover" | "enforce" (4.6), shared by all adapters
  "sbx": { "kitDir": "<path>", "memory": "4g" }  // adapter's own block, adapter-validated
}
```

- CLI `--sandbox=<name>` (a new value flag in `src/core/cli-args.ts`)
  overrides `sandbox.adapter`. `--sandbox=none` turns it off for one run
  even if config enables it.
- `config.ts` validates keys strictly (e.g. `keys(...)` around line 177),
  so add `sandbox`, `adapter` and `mode` there. Each adapter's sub-block is
  handed to that adapter's own validator. Shared config code never lists
  `kitDir`. Update `docs/config.md` first, per CLAUDE.md.
- The kit moves out of `/tmp/sbx-spike/kit`, which is wiped on reboot,
  into a permanent location the user picks. Config holds only the path.

**Removing sbx later:** delete `src/sandbox/sbx/` and its registry line,
then drop the `sbx` sub-block from any config. Nothing else references it.

### 4.4 Mounts (adapter-neutral; the shared code computes them)

1. The dev-loop repo root: the agent's cwd, skills, agents, hooks and run
   dir.
2. The target repo's **main checkout**, which holds `.git/worktrees/<name>`.
3. The per-run worktree. This is usually inside (2) already; mount it
   explicitly if it ever isn't.

Paths must resolve identically inside and outside, because `--add-dir`,
`denyEditsUnder`, `claudeMdExcludes` and the skill invocation all pass
absolute host paths. The interface promises **same-path mounts**. An
adapter that can't provide them fails `preflight`. **Builder must verify
this for sbx with a `/Users/...` path.** The spike only proved it under
`/tmp`. Don't build path translation.

Never mounted: `$HOME`, `~/.ssh`, `~/.config`. Known gap: `.envrc` files
inside the target repo are visible, which is the same exposure as today.
Note it here; it isn't solved in this design.

### 4.5 Failure detection (independent of any sandbox; ships first)

Today a zero exit code is a success (`spawn-claude.ts` ~487-496), and
`is_error` / `terminal_reason` are read nowhere in `src/`. Change:
- `SpawnClaudeResult` gains `resultError?: { is_error: boolean;
  terminal_reason?: string }`.
- It is read from the parsed final result: the `type === "result"` line in
  stream mode (already parsed, ~436), or the whole JSON document otherwise.
- The run fails as `agent_error` if `is_error` is true,
  `terminal_reason` is outside the allowed set, or no result arrived.
  The allowed set is pinned from real runs; see "Resolved during the
  foundation build" in §9 (Allowed terminal reasons).

### 4.6 Denials: `sandbox_denied` and the `parked` outcome (shared, adapter-neutral)

- Add `sandbox_denied` to `FailureCategory` (`types.ts:13`), and update the
  v2 design's enum list in the same change.
- Add an iteration outcome `parked` (`iteration-log.ts`), modelled on
  `interrupted`: `phases: []` and `resume: <role>` set, so
  `failedAttempts` (`iteration-log.ts:~160`, which counts only `error` and
  `killed`) doesn't count it. Update any exhaustive switches and
  `scripts/stats.mjs`.
- Triggers: `inspect` returns any `denied` entries, or `preflight` fails
  mid-session. For sbx, `inspect` reports exit 125 as `infra`, `policy log`
  blocks as `network`, and an unapproved credential as `credential`. The
  check runs **before** reading `verdict.json` (in
  `src/worker/skill-runner.ts`, after the spawn call). An agent's verdict
  written while blocked isn't trusted.
- Behavior: no attempt counted, no Jira status change. The run log gets
  the denied targets and the `approveHint`. A desktop notification fires,
  and the loop continues with other tickets.
- Un-parking: the poll skips a ticket whose latest record is `parked`. A
  new `npm run sandbox:approvals` command lists parked tickets with
  their denied targets and the adapter's `approveHint`. It **prints** the
  allow commands for the user to run and never runs them.
  `npm run sandbox:approvals -- --clear=<KEY>` appends a record that
  resolves the park. The existing resume/recover path then re-runs it.
- `mode: "discover"`: `inspect` results are logged and reported but don't
  park the ticket. **Builder must check whether sbx can log without
  blocking.** If it can't, discover mode means "run, collect, report", and
  a failed discovery run on a throwaway ticket is acceptable.

Analogy: the front desk refuses a delivery. The job goes on hold with a
sticky note saying what was refused, instead of being marked a failed
attempt.

### 4.7 Credentials and preflight (sbx specifics)

- Every credential the agent needs inside goes into the sbx secret store
  and is injected by the proxy. That covers Keystone (done), a GitHub
  token for git/gh, and whatever the Atlassian MCP uses. Nothing travels
  in argv or env. The Jira REST token stays host-only.
- sbx `preflight`: create a throwaway instance and exec a small check
  (`node --version`, `git --version`, `gh auth status`, and a minimal
  Keystone call), then tear it down. On failure it throws a plain message
  naming the fix (e.g. "credential not approved: run
  `sbx run claude --kit <kitDir> <any dir>` once and choose Approve all").
  If preflight fails, the loop doesn't start.
- **Open (user):** how the Atlassian MCP authenticates from inside a
  sandbox. If it is a host-bound browser OAuth, the clean answer may be
  to have the host loop post Jira comments instead of the agent. That is a
  bigger change, so decide it after discovery.

### 4.8 Image requirement: node

All five `.claude/hooks/*.sh` call `node` on a checker script and **deny
when it fails**. Without node, every Bash call is blocked. That fails
safe, but leaves the agent useless. The target's `npm test` needs node too.
Any adapter's environment must provide node at the host's major version.
That is part of the shared contract and checked in preflight. For sbx,
add it to the kit or template rather than installing it per run.

### 4.9 The block-unsafe-git hook

Inside any sandbox the agent runs plain `git`/`gh`, so the hook behaves as
today. The spike's "unknown wrapper" block came from the operator's own
session typing `sbx exec … git commit`. dev-loop's Node code calls the
adapter via `spawn()`, not through a Claude Bash tool, so no hook change
is needed. Don't add `sbx` to the hook's allowed wrappers.

## 5. Parallel loops on one repo

The adapter is compatible with parallel loops but doesn't enable them by
itself. Each run gets its own worktree and its own uniquely named sandbox
instance, so concurrent runs share nothing mutable except the main repo's
`.git`, and the spike showed concurrent commits there are safe. What
still blocks N loops per repo is the one-live-worker lockfile
(`src/core/session.ts`) and the missing atomic claim (v2 design §7). Batch
orchestration is §8. The sbx `memory` setting sets the practical ceiling
on this Mac at about 3–4 concurrent sandboxed runs.

## 6. Observability

- Logs and progress are in mounted folders, so `tail -f` on the host works
  for any adapter.
- The run log gains `sandbox: { adapter, instance, prepare_ms }`, plus the
  denied list on park.
- sbx extra: running `sbx` with no args opens a live dashboard.

## 7. Testing

- **Shared adapter contract suite** (`test/sandbox/contract.test.ts`). It
  is parameterized over every registered adapter, using fake command
  runners so it is free and runs offline. It checks: `teardown` is
  idempotent and called on success, error, timeout, a thrown spawn, and a
  signal; `wrap` preserves the args; `inspect` maps to the shared
  `SandboxReport`. A future adapter must pass it to be registered.
- `none` adapter: the existing spawn tests pass unchanged, and an explicit
  test pins identical argv/env with and without `--sandbox=none`.
- `sbx` adapter unit tests: argv for create/exec/rm, exit 125 → `infra`,
  `policy log` JSON parsing (from a captured fixture), and orphan cleanup
  matching only this project's `dl-<len>-<project>-` prefix.
- Shared: `parked` not counted by `failedAttempts`, poll skip and clear,
  CLI precedence (`--sandbox=` over config), unknown adapter rejected, and
  4.5 result-error detection.
- A structure test that greps `src/` outside `src/sandbox/sbx/` for
  `sbx`, so the coupling anti-goal is enforced.
- Live: one attended smoke run from the user's shell, then the eval
  harness run twice (host vs sbx) on the same tickets, comparing outcome,
  cost and wall time. Paid evals only from the user's shell with
  `DRY_RUN=0`.

## 8. Rollout order

1. Result-error detection (4.5). Standalone, no sandbox.
2. Adapter interface, the `none` adapter, the registry, `--sandbox=`, the
   config block, `parked` / `sandbox_denied`, and `sandbox:approvals`.
   Behavior is unchanged because the default is `none`.
3. The sbx adapter plus preflight and orphan cleanup.
4. User steps: move the kit, add node to the template, set the secrets,
   approve the credential once.
5. `--sandbox=sbx` in discover mode on one throwaway ticket, attended.
   The user adds allow rules.
6. Enforce on one project, then the host-vs-sbx eval comparison.
7. The default stays `none` until the user changes config.

## 9. Open items

- Builder verifies: same-path mounts for `/Users/...` (4.4), sbx log
  without block (4.6), and that
  `teardown` actually stops the inner process when the wrapper is killed.
- User decides: Atlassian MCP auth inside the sandbox (4.7), the kit's
  permanent location, and the GitHub token scope for the sandbox secret.
- Builder's call: the exact instance-name format, the notification
  wording, and the TypeScript shape of the interface (keep it
  sandbox-neutral).

### Resolved during the foundation build

- **Allowed terminal reasons (Task 1).** `ALLOWED_TERMINAL_REASONS = ["completed"]`. Four local usage.json files from real runs all had `terminal_reason: "completed"`, and the spike's stall had `api_error`. An absent `terminal_reason` with `is_error: false` passes.
- **`validateConfig(raw)` (Task 2).** It was added to the SandboxAdapter interface so each adapter validates its own `sandbox.<name>` sub-block, and config.ts never learns adapter keys.
- **Instance names (step 3 prep).** `dl-<len>-<project>-<ticket>-<role>-<6 hex>`, sanitized to `[a-z0-9-]`, where `<len>` is the sanitized project name's length. With a bare `dl-<project>-`, project `a`'s cleanup scope would also match project `a-b`'s sandboxes; the length makes every prefix unique. The `prepare` failure message is redacted before it becomes `spawnError` / `approveHint`.
- **Mounts (Task 5).** `sandboxMounts(repoRoot, repoDir)` gives `[repoRoot, repoDir]`, deduplicated, with repoDir dropped when it is inside repoRoot. The per-run worktree lives inside repoDir, so there is no separate worktree mount.

### Verified before step 3 (sbx v0.53.0, 2026-11-12)

- **Same-path mounts work for `/Users/...`.** `sbx create … <path>` mounts each path at the identical container path (`host_mounts[].container_target == host_path`), writes show up on the host at once, and two paths in one create both mount read-write. **Case trap:** sbx canonicalizes the host path's case (a shell in `~/Desktop/repos/...` mounts at `.../Repos/...`), but the container's filesystem is case-sensitive, so a lowercase path in argv (`--add-dir`, `run-dir=`, `-w`) fails with "No such file or directory". The adapter's preflight must require every mount, and the cwd, to equal `fs.realpathSync.native(p)`, and name the fix ("cd into the real-case path and restart") otherwise.
- **Discover mode is possible.** A blocked host returns HTTP 403 to the agent and the run carries on; `sbx policy log <name> --json` lists it under `blocked` (`host`, `reason`, `count`) and `sbx policy approval ls --json` lists a pending approval (`sandbox_name`, `title` = `host:port`). Nothing waits on the approval.
- **inspect works after teardown** (carry item (a)): `policy log <name>` still returns the removed sandbox's blocked list. Pending approvals do not survive `rm`, so network denials come from `policy log`, not `approval ls`.
- **Killing the `sbx exec` wrapper does not stop the inner process** (it kept running after SIGTERM to the wrapper). `sbx rm --force` removes the container and everything in it, so teardown is the stop. This matches the existing design: the kill path calls teardown.
- **Exit codes:** the inner command's code passes through (`exit 7` → 7); a missing sandbox exits 125. `sbx rm --force` of a missing sandbox exits 1 with "not found", which teardown treats as done.
- **Names:** 2–63 chars of letters, digits, hyphens, periods (`'default'` reserved). Instance names must be capped at 63.
- **Create** with the claude agent plus the kit (`sbx create --name N --no-progress --no-input claude --kit <kitDir> <paths…>`) took ~5 s with a cached image, headless, no prompt.
- **Env:** `sbx exec -e NAME` takes the value from the wrapper's own env, so allowlisted names pass without values in argv. The kit sets `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (proxy-managed) and the agent sets `CLAUDE_MODEL`; the host's `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` are not set inside and must be allowlisted so the `sonnet` alias resolves as on the host.
- **Still missing in the image:** `node` (§4.8). `gh` is present but not logged in; the GitHub token goes in with `sbx secret set github` (user step 4).
- **Kit:** `~/Desktop/Repos/keystone-bedrock-kit` and `/tmp/sbx-spike/kit` have identical kit files; config points at the permanent one.

### Carried into step 3 (sbx adapter)

Requirements found during the foundation build:

- (a) On the timeout and kill paths, teardown starts before inspect. The sbx adapter must make inspect work on a torn-down instance, or have teardown snapshot the denial report first. Consider adding this to the contract suite. Resolved: `inspect` runs `sbx policy log`, which answers for a removed sandbox (`src/sandbox/sbx/adapter.ts`).
- (b) A signal during prepare leaves the instance behind, and cleanupOrphans is the backstop. Resolved: `cleanupOrphans` is the backstop (`src/sandbox/sbx/adapter.ts`).
- (c) `sandboxInstanceName` is now sanitized to `[a-z0-9-]` and carries `<len>-<project>`, but has no length cap. Confirm sbx's naming rules and cap the length if needed. Resolved: names capped at 63 chars, with a startup error for a prefix over 56 chars.
- (d) `TEARDOWN_GRACE_MS` (30s) bounds the teardown wait. An abandoned teardown keeps running, and cleanupOrphans cleans it up. Resolved: `cleanupOrphans` is the backstop.
- (e) The registry test pins `adapterNames()` to `["none"]`. Update it when sbx registers. Resolved: the registry test now pins `["none","sbx"]`.
- (f) An all-infra refusal (daemon down, prepare throws) is not ticket-specific; parking ticket after ticket walks the queue (each claimed + notified). Step 3 must make an all-infra report pause the worker instead (or in addition to parking). Resolved: an all-infra park pauses the worker (`src/worker/cycle.ts`).
- (g) prepare / inspect / preflight / cleanupOrphans have no timeout; runTimeoutMin starts only in runChild. Add a prepare timeout that becomes an infra denial. Resolved: `PREPARE_TIMEOUT_MS` 300 s and `INSPECT_TIMEOUT_MS` 60 s, both infra denials (`src/core/spawn-claude.ts`).
- (h) Spec §6 run-log `sandbox: {adapter, instance, prepare_ms}` is built on SpawnClaudeResult but not persisted; carry it onto the PhaseEntry / parked record. Resolved: `sandbox` metadata is on `PhaseEntry` and `ParkedRun` (`src/core/types.ts`).
- (i) ALLOWED_TERMINAL_REASONS is one value; a new success reason from a future CLI would turn every run into agent_error. Log unknown reasons prominently; document how to extend the list. Resolved: an unknown `terminal_reason` is logged with the extend instruction (`src/core/spawn-claude.ts`).
