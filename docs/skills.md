# Skills

## ticket-to-pr

`.claude/skills/ticket-to-pr/SKILL.md` — the executor. Invoked by the loop
runner as `claude -p "/ticket-to-pr <TICKET-KEY>"`. Runs a fixed phase
sequence against an isolated per-run `git worktree`, on its own branch,
branched off `targetRepo.path` (a local checkout, if configured — its
`origin` is already the real remote, so push/PR need no extra setup) or a
shared fetch-only clone at `.pipeline/<slug>/repo` otherwise (see
`docs/logging.md`) — never that source checkout directly, so a human
working in it manually is never affected by a background run:

1. **Intake** — find the research-loop comment (title starts with `✅
   research-loop -`, per research-loop's own comment convention) and
   confirm it has the template sections populated; bounce immediately if
   the comment is missing or malformed.
2. **Plan** — break the research-loop comment's acceptance criteria into
   concrete steps; bounce on any AC that requires inference it doesn't
   state.
3. **Red** — write a failing test per AC, confirm it fails for the right
   reason, commit tests before any implementation.
4. **Green** — implement the minimum change to pass, touching only the
   files the ticket's Scope section names.
5. **Verify** — full suite must be green; also runs whatever the target
   repo's own CI runs beyond tests (lint, typecheck, build) so a
   lint/build failure is caught here, not after the PR is already open;
   spawns `qa-agent` (see below) for a fresh-context adversarial pass, up
   to 3 retry loops.
6. **PR** — Phase 4 finishes all reasoning (title, `## Changes` bullets,
   `qa_notes`); Phase 5 is then mechanical: it reads the operator's local
   `~/.claude/skills/push-branch/SKILL.md` and follows it in its
   *content supplied* mode with `--no-jira`, so the push (hooks on), the
   create-or-edit-existing-PR step, and the body shape
   (`## Jira Ticket` / `## Changes` / `## QA Notes` manual steps) live in
   one place. That skill is **machine-local, not in this repo** and is the single
   source of truth for both manual and loop use; if it is missing, Phase 5
   bounces `env_setup` rather than carrying its own copy. Writes
   `verdict.json`.

**Resume, not restart.** If a `<TICKET>-*` branch already has commits ahead
of the default branch (e.g. from an earlier `verify_rejected` bounce), the
run creates its worktree *on that branch* instead of a fresh one, merges the
default branch in, plans only the work the newest spec still needs, and gets
a fresh 3-loop verify budget. Ambiguous cases (several candidate branches,
local/remote divergence) bounce `env_setup` rather than guess. A bounce never
pushes, and its `detail` must say whether the branch is on `origin`
(`git ls-remote`), never just "pushed". See the skill's "Resume" section.

Core rule: this skill **never edits the spec**. Any ambiguity, contradiction,
or oversized scope is `research-loop`'s problem to fix upstream — this skill
bounces with evidence instead of guessing.

**A bounce's evidence reaches the ticket itself, not just runs.jsonl.**
`ticket-to-pr` has no Jira-write tool of its own (see "Model policy" below,
and `ALLOWED_TOOLS` in `src/main.ts`) — it only writes `verdict.detail`
into `verdict.json`. The loop runner (`runLoopIteration` in
`src/roles/dev/phase.ts`) is what turns a genuine bounce (`verdict.pr === null`)
into a Jira comment, via `buildBounceCommentAdf()` + `JiraClient.addComment`,
posted immediately before the existing Blocked transition. Before this
existed, a bounce's only trace was the local `runs/<project>.jsonl` line —
the ticket itself went Blocked with nothing explaining why, which is exactly
what made TARS-1441/TARS-1438 look opaque on 2026-09-14 (see CHANGELOG).

**Ticket content protocol**: the ticket's description is the stakeholder's
original, untouched by `research-loop`, and is background context only —
never authoritative for AC/Scope. The research-loop comment (title starts
with `✅ research-loop -`) is the actual work order (see research-loop's
`docs/skills.md` for why it lives in a comment instead of the
description).

**Cleanup is a hard gate, every run**: stop the dev server if one was
started (by this skill or by `qa-agent`), and remove this run's worktree —
with one exception. If the run **landed** or **bounced with everything
already committed**, the worktree is removed unconditionally. If the run
**bounces with uncommitted in-progress work** still in the working tree,
the worktree is deliberately **kept** (and the bounce detail says so) so a
human or `ticket-refine`'s revision pass can inspect exactly what was
tried. That single case is the only conditional part of Cleanup — dev
server shutdown is never conditional.

## qa-agent

`.claude/agents/qa-agent.md` — a genuinely fresh-context subagent spawned
during Verify. It sees only the ticket key, the path to `ticket-to-pr`'s
already-created run worktree, and the dev-loop checkout path (to run
`src/roles/dev/qa-browser.ts`; never echoed into PR/Jira) — never the implementer's reasoning — and
checks, against the research-loop comment's AC/Scope (not the description):
AC satisfaction, scope discipline (no files touched beyond what Scope
names), regressions, test quality, and unrelated diff noise. Not
limited to static diff reading: for ACs that are visual, timing-sensitive,
or otherwise hard to trust from a diff and its tests alone, it starts the
app and exercises the behavior directly — and if it does, stopping it is
its own hard gate, independent of `ticket-to-pr`'s end-of-run Cleanup (it
started it, it stops it).

Browser checks go through one pinned helper, `src/roles/dev/qa-browser.ts` (Playwright
is a devDependency of dev-loop; a human runs `npm run setup-qa` once to fetch
the matching Chromium). It is localhost-only, and the agent is forbidden from
installing or downloading anything mid-run: if the browser is unavailable the
criterion is reported **unverified**, not worked around.

**Auth is deliberately not handled.** Local dev at `localhost:3000` shows a
login form (webtarsthree's client gate is a token in `localStorage`; the real
login uses the employee auth service). The qa-agent must not forge tokens or
use credentials, so UI behind the login is reported **unverified (needs
human)** for a person to check. See CHANGELOG 2026-09-30 for how earlier runs
got past it and why that stopped.

The qa-agent never manages the worktree itself — that lifecycle belongs to
`ticket-to-pr`. Returns `pass`/`fail` plus concrete findings the implementer
can act on.

## Model policy

`ticket-to-pr` runs on `--model sonnet` (pinned explicitly in the invocation
command, not an ambient default) — it's the literal-minded executor tier per
the spec, never the tier that questions the spec. `qa-agent` pins `model:
sonnet` in its own frontmatter too, so it doesn't inherit a different model
from whatever spawned it.

## verdict.json contract

Every skill run writes `RUN_DIR/verdict.json` (schema in the SKILL.md file
itself). The loop runner (`src/roles/dev/phase.ts`) reads it via
`parseVerdict()` in `src/core/verdict.ts` — a missing or malformed file becomes
`outcome: "error"`, `failure_category: "agent_error"`, never a crash. The
loop runner derives the real `RunLogLine` (adding ticket/skill/timing
metadata the skill doesn't need to self-report) from this verdict — it no
longer derives any epic-or-label-move decision from the verdict at all
(`decideEpicMove` was deleted; no loop moves anything epic-or-label-shaped
on a landed dev-loop verdict).

**Closed `failure_category` enum** — do not add or remove values without
updating the pipeline spec: `spec_ambiguous · spec_contradicted · blocked ·
too_large · tests_flaky · env_setup · verify_rejected · subagent_stall ·
merge_conflict · agent_error · killed_ceiling`.

**`qa_notes` (optional `string[]`)** — sequential manual-testing steps for
a human QA reviewer (real routes/URLs, one action + one `Expected:` result
per Acceptance Criterion), written by `ticket-to-pr` in Phase 4 (see
SKILL.md). The loop runner's `buildQaNotesAdf()` renders this into Jira's
QA Notes field (`codeReviewFields.qaNotesField`) as a bold "Manual testing
steps:" header + ordered list, with `Expected:` entries bold-marked —
falling back to a terse `PR: <url>` / `Verify loops: N` stub when absent
or empty. The PR body's `## QA Notes` section carries this same list (numbered,
matching `push-branch`'s format); the earlier pass/fail summary was removed
from the PR and lives only in `verdict.json` / `progress.jsonl`.
When `qa-agent` reports an AC as **unverified (needs human)** (e.g. UI behind
the login), that AC's first `qa_notes` entry is prefixed
`[Not verified by automation] ` so it survives into Jira and the PR.
