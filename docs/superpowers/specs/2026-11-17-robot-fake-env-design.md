# Robot fake env — design

Date: 2026-11-17. Branch: `feat/robot-fake-env`.

## Intent

The robot (the research and dev agents) runs the target repo's app and tests.
Today it does that through `direnv exec <worktree>`, and because every
worktree sits inside the target repo (`<REPO_DIR>/.claude/worktrees/…`),
direnv walks up and loads the person's **real** `.envrc`. That file holds real
keys. The robot never needs them: webtarsthree's unit tests pass with no
`.envrc`, and its integration tests pass with only a placeholder
`PLACEMENT_SERVICE_ENDPOINT`.

Goal: the robot never sees the real `.envrc`, in either mode, and everything
still works (the app starts, the tests pass). The guide's `.envrc` row ends at
"No".

- **sbx:** a hard No. The file is not visible inside the sandbox, and
  preflight refuses to start if it is.
- **No sandbox:** a soft No. The robot's direnv loads fake values, and a deny
  rule blocks reading the real file. A determined Bash command can still read
  it, and the guide says so ("No, by rule only").

## Goals

1. The robot's env comes from the target repo's committed `.envrc.example`,
   never from the real `.envrc`. Both phases, both modes.
2. sbx: the real root env files of the target repo are covered inside the
   sandbox. Preflight checks this from inside a sandbox and refuses if a real
   one shows through.
3. No sandbox: a `Read` deny rule on the target repo's real root env files for
   every research and dev spawn.
4. New settings: when a ticket adds a setting, the robot adds it to
   `.envrc.example` with a fake value. The PR body says "New settings: add the
   real INT value to your .envrc" and names each one.
5. A setting the code needs that `.envrc.example` lacks is a bounce
   (`env_setup`, naming the setting), never a guess and never a read of the
   real file.
6. Host push still uses the real env on the host, as today.
7. The guide, `docs/sandbox-sbx.md`, CHANGELOG and future-enhancements are
   updated in the same change.

## Non-goals

- **The drift check** (a mechanical check that `.envrc.example` lists every
  setting the code reads). webtarsthree's example already drifts from its
  `.envrc`, so it would bounce every ticket. It goes in
  `docs/future-enhancements.md`, with a note to fix webtarsthree's example
  first.
- Env files below the repo root (e.g. `server/.env`). Only the root ones are
  covered, as preflight does today.
- sbx adding real INT keys on the way out, and a typed env schema plus vault
  refs. Both go to future-enhancements.

## Anti-goals

- The robot reaching a real value by any route the loop opens for it.
- The loop executing anything from `.envrc.example`. It is parsed as text and
  every value is written back single-quoted, so `$(…)` stays literal.
- Changing what host push does.
- Breaking the plain loop (no sandbox): it must still run the app and tests.

## Design

### The fake env file (both modes) — `src/core/fake-env.ts`

The loop, not the robot, writes `<REPO_DIR>/.claude/worktrees/.envrc`.
Every worktree the robot makes sits in that folder, so direnv stops there and
never reaches `<REPO_DIR>/.envrc`. (Verified: `direnv exec DIR` loads the
first `.envrc` found walking up from DIR, and evaluates it with `$PWD` at the
file's own folder, so one file serves every worktree.)

- Source: `git -C <REPO_DIR> show origin/<defaultBranch>:.envrc.example`,
  the committed copy, not a person's working-tree edit. Missing (no such
  file, or git fails): the fake has only its header and no exports.
- Parse: only lines `export NAME=VALUE` (`NAME` matching
  `[A-Za-z_][A-Za-z0-9_]*`, leading spaces allowed). Commented-out lines and
  anything else are skipped. A value wrapped in matching `"…"` or `'…'` is
  unwrapped; otherwise it is used as written, trimmed.
- Render: a fixed first line (the marker), then one
  `export NAME='value'` per setting, single quotes escaped (`'\''`). Marker:
  `# dev-loop fake env: generated from .envrc.example, never real values`.
- A second file, `<REPO_DIR>/.claude/worktrees/.dev-loop-hidden-env`, holds
  only the marker line. sbx mounts it over the real files (below).
- Allow: the loop runs `direnv allow <REPO_DIR>/.claude/worktrees/.envrc` on
  the host after writing it. If direnv isn't installed, it skips this (the
  skills already bounce when direnv is missing). *My call:* the skills still
  never run `direnv allow`. The loop may, because it wrote every byte of the
  file and it holds only quoted exports.
- When: once at startup, before preflight (sbx needs the files to mount), and
  again before every research and dev run, so a changed example is picked up.
  The write is skipped when the content is unchanged; the allow always runs.
- `.claude/worktrees/` is git-ignored in webtarsthree. The skills already
  expect that folder to be ignored.

A new setting the robot adds to the worktree's `.envrc.example` is not in the
fake until the next run reads origin. While testing, the robot passes it
inline: `direnv exec <wt> env NAME=<fake> npm run dev`.

### sbx: a hard No — `src/sandbox/sbx/`

- **Cover the real files.** For each mount other than dev-loop's own root,
  every root env file (`rootEnvFiles`: `.env`, `.envrc`, `.env.*`, never
  `*.example`) gets a read-only mount of the hidden-env file over it:
  `<dir>/.claude/worktrees/.dev-loop-hidden-env:<dir>/<file>:ro`. Verified
  with sbx v0.54.0: the sandbox reads the overlay, and writes fail
  ("Read-only file system"). `prepare` and preflight both add these mounts.
- **Allow the fake inside the sandbox.** After `create`, `prepare` and
  preflight run `direnv allow` inside the sandbox on
  `<dir>/.claude/worktrees/.envrc` and on each covered `.envrc`. The allows
  the template saved are no longer used.
- **Preflight refuses a visible real file.**
  - It refuses if the fake files are missing on the host.
  - It adds a check step (`dl-step:hidden`): each covered path's first line
    inside the sandbox must be the marker. If not, it refuses with "a real
    `<file>` is visible inside the sandbox".
  - The old `envrcCheck` now runs `direnv exec <dir>/.claude/worktrees true`.
  - The "note: the sandbox agent can read .envrc…" warning goes away.
- **Template build** (`scripts/sbx.mjs template:build`) no longer mounts the
  target repo and no longer asks to allow its `.envrc`. Nothing needs it now.

### No sandbox: a soft No — `src/core/spawn-claude.ts`, `src/worker/skill-runner.ts`

- `SpawnClaudeOpts` gains `denyReads?: string[]`, absolute file paths, the
  same safety check as `denyEditsUnder`. `settingsJson` turns each path into
  `Read(//<path>)` in the same `permissions.deny` list.
- `makeRunSkill` passes the target repo's root env files
  (`<REPO_DIR>/<f>` for each `rootEnvFiles(REPO_DIR)`) as `denyReads` for
  both roles. It does this in sbx mode too, where it is harmless.
- `.envrc.example` is not denied: the robot reads and edits it.
- This stops the `Read` tool only. A Bash `cat` can still read the file,
  which is why the guide says "by rule only". The skills' text adds a rule
  never to read it.

### Host push stays real — `src/worker/host-push.ts`

The push worktree is also under `.claude/worktrees/`, so after this change
`direnv exec <wt>` would load the fake. To keep host push unchanged, its
direnv calls (`git`, `npm ci`, and the prompt's `direnv exec`) name
`<REPO_DIR>` instead of the worktree. `direnv exec <REPO_DIR> <cmd>` loads
the real `.envrc` and runs `<cmd>` in the current folder (the worktree).
`hostPushPreflightProblem` and main.ts's `direnv status` are unchanged.

### Skills and agents text

Update the passages that say the worktree sits in the repo "so direnv picks
up its real `.envrc`":
- `ticket-to-pr` (Target repo; Install; the PR-body rules),
- `ticket-refine` (the worktree passage; rule 8),
- `recon-agent`,
- `qa-agent`.

They now say:
- direnv in a worktree loads the loop's **fake** env, built from
  `.envrc.example`. Never read `<REPO_DIR>/.envrc` or `.env`. Never copy
  `.envrc.example` to a `.envrc`.
- ticket-to-pr, new settings: add each to `.envrc.example` with a fake value
  and a one-line comment. The PR body gets a `New settings:` line naming
  each, ending "add the real INT value to your .envrc". While testing, pass
  it inline (`env NAME=<fake>`).
- Missing setting: the code needs a setting the fake lacks, and the ticket
  isn't adding it. Bounce `env_setup`, naming the setting. Never invent a
  real-looking value, and never read the real file.
- The never-write-a-secret rules stay, with the reason reworded (defense in
  depth, not "real secrets are here").

A text-guard test (`test/skills/robot-fake-env.test.ts`) pins the key
phrases.

### Docs

- **Guide (`docs/guide/how-dev-loop-works.html`):**
  - The `.envrc` row: sbx "No" (`can("no", …)`); none "No, by rule only"
    (`can("warn", …)`).
  - Fix the `env-sub` text.
- **`docs/sandbox-sbx.md`:**
  - The template step drops "type allow".
  - The env-file section says the real files are covered and checked.
- **CHANGELOG:** a `[dev]`/`[research]`/`[core]` entry under Unreleased.
- **future-enhancements:**
  - the drift check, with a note to fix webtarsthree's example first;
  - sbx INT-key injection;
  - a typed env schema plus vault refs.

## Answers to the builder check

- **Source of the example:**
  - `REPO_DIR` is `repoDirFor(config, slug)` (`targetRepo.path`, else the
    v2 clone), and the branch is `targetRepo.defaultBranch`.
  - The loop does not fetch: each skill run fetches origin first, so the
    fake is at most one run behind. A setting newer than that is passed
    inline (see above).
  - No clone yet: the fake is empty.
- **Sandbox allow vs a changed fake:**
  - Each run gets a new sandbox, and the refresh happens before the spawn
    (and so before `prepare`). So `prepare`'s allow always sees the current
    file.
  - Only one worker runs per project (the session lock), so no other live
    sandbox shares the file.
  - The write goes to a temp file plus rename anyway.
- **`env_setup`** is already a `failure_category` (src/core/types.ts).
- **Which files get covered:** only files that exist when `prepare` runs.
  Every run rescans. A file created mid-run is not covered (noted as a
  limit). Preflight checks the files present at startup.
- **sbx paths:**
  - Mounts keep host paths inside the sandbox (seen in the probe), so the
    overlay targets and `denyReads` name the same paths in both modes.
  - In sbx mode, `denyReads` is redundant but correct.
- **Expansion:** webtarsthree's example has no `$` in any value. Values are
  written literally, and cross-references are not expanded (*my call*).
- **Host push:**
  - `<REPO_DIR>/.envrc` sits above `.claude/worktrees/`, so the fake never
    shadows it for `direnv exec <REPO_DIR>`.
  - `hostPushPreflightProblem` still checks that the real file is allowed.

## Changes after the final review (2026-11-17)

- **The sbx cover is folder-level, not per file.**
  - A live probe showed a per-file `:ro` cover is bypassed by `.ENVRC`
    (the Mac's disk is case-insensitive).
  - The target repo's top folder is now never mounted. `coverMounts` swaps
    it for `<repo>/.git` and `<repo>/.claude/worktrees`.
  - Inside the sandbox, the loop sets `safe.directory` for the repo and
    allows the fake.
  - Preflight checks that no env file, in any case, is visible at the top.
  - Verified end to end with sbx v0.54.0: no env file was visible, the
    fake loaded, and a worktree made inside the sandbox showed up on the
    host.
  - The marker-only file is gone.
- **A person's own worktrees** in `.claude/worktrees/` (`okta-wave-1`, …)
  keep their real env.
  - The fake starts with a handover: when `DEVLOOP_ROBOT_ENV` is unset and
    `<repo>/.envrc` exists, it runs `source_env` on the real file and
    returns.
  - Robot spawns set `DEVLOOP_ROBOT_ENV=1`.
  - In sbx the real file isn't there, so the handover can't fire.
  - With no sandbox, this is the same soft line as the Read deny.
- **Parsing:**
  - A trailing ` # note` is dropped.
  - `PATH`, `HOME`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `DIRENV_*`, `GIT_*`
    and similar are never overridden.
  - Env-file names with a space or colon are skipped by the deny list.
- **Known limit:** a never-cloned repo dir gets its fake on the run after
  the clone.

## What's left to the builder

Names of private helpers, test layout, and how the per-run refresh is wired
in as an injected dependency (it must be injectable so tests never touch real
files or direnv).

## Calls I made (no user input)

- One fake at `.claude/worktrees/.envrc` instead of one per worktree. The
  robot creates the worktrees, so the loop can't write into them first.
- The loop runs `direnv allow` on its own generated file.
- sbx covers real files with a marker-only file, not the fake values. Fake
  values come from `.claude/worktrees/.envrc`.
- Template build stops mounting the target repo.
- Host push switches its direnv dir to `<REPO_DIR>` to keep the real env.
- "Missing setting bounces" is the robot's call at the moment it hits one.
  The mechanical drift check is deferred, per the user.
