# Skills

## ticket-to-pr

`.claude/skills/ticket-to-pr/SKILL.md` — the executor. Invoked by the loop
runner as `claude -p "/ticket-to-pr <TICKET-KEY>"`. Runs a fixed phase
sequence against an isolated per-run `git worktree`, on its own branch, off
the shared target-repo clone at `.pipeline/<slug>/repo` (see
`docs/logging.md`) — never the shared clone directly, so a human working in
it manually is never affected by a background run:

1. **Intake** — confirm the ticket is actually ready (has the
   `research-loop` template sections populated); bounce immediately if not.
2. **Plan** — break acceptance criteria into concrete steps; bounce on any
   AC that requires inference the ticket doesn't state.
3. **Red** — write a failing test per AC, confirm it fails for the right
   reason, commit tests before any implementation.
4. **Green** — implement the minimum change to pass, touching only the
   files the ticket's Scope section names.
5. **Verify** — full suite must be green; also runs whatever the target
   repo's own CI runs beyond tests (lint, typecheck, build) so a
   lint/build failure is caught here, not after the PR is already open;
   spawns `qa-agent` (see below) for a fresh-context adversarial pass, up
   to 3 retry loops.
6. **PR** — push the branch, open the PR, write `verdict.json`.

Core rule: this skill **never edits the spec**. Any ambiguity, contradiction,
or oversized scope is `research-loop`'s problem to fix upstream — this skill
bounces with evidence instead of guessing.

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
during Verify. It sees only the ticket key and the path to `ticket-to-pr`'s
already-created run worktree (never the implementer's reasoning) — and
checks: AC satisfaction, scope discipline (no files touched beyond what
Scope names), regressions, test quality, and unrelated diff noise. Not
limited to static diff reading: for ACs that are visual, timing-sensitive,
or otherwise hard to trust from a diff and its tests alone, it starts the
app and exercises the behavior directly — and if it does, stopping it is
its own hard gate, independent of `ticket-to-pr`'s end-of-run Cleanup (it
started it, it stops it). It never manages the worktree itself — that
lifecycle belongs to `ticket-to-pr`. Returns `pass`/`fail` plus concrete
findings the implementer can act on.

## Model policy

`ticket-to-pr` runs on `--model sonnet` (pinned explicitly in the invocation
command, not an ambient default) — it's the literal-minded executor tier per
the spec, never the tier that questions the spec. `qa-agent` pins `model:
sonnet` in its own frontmatter too, so it doesn't inherit a different model
from whatever spawned it.

## verdict.json contract

Every skill run writes `RUN_DIR/verdict.json` (schema in the SKILL.md file
itself). The loop runner (`src/loop-runner.ts`) reads it via
`parseVerdict()` in `src/verdict.ts` — a missing or malformed file becomes
`outcome: "error"`, `failure_category: "agent_error"`, never a crash. The
loop runner derives the real `RunLogLine` (adding ticket/skill/timing
metadata the skill doesn't need to self-report) and the epic-move decision
from this verdict.

**Closed `failure_category` enum** — do not add or remove values without
updating the pipeline spec: `spec_ambiguous · spec_contradicted · blocked ·
too_large · tests_flaky · env_setup · verify_rejected · subagent_stall ·
merge_conflict · agent_error · killed_ceiling`.
