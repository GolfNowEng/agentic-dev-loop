# Skills

## ticket-to-pr

`.claude/skills/ticket-to-pr/SKILL.md` — the executor. Invoked by the loop
runner as `claude -p "/ticket-to-pr <TICKET-KEY>"`. Runs a fixed phase
sequence against a persistent target-repo checkout at
`.pipeline/<slug>/workdir/<slug>`:

1. **Intake** — confirm the ticket is actually ready (has the
   `research-loop` template sections populated); bounce immediately if not.
2. **Plan** — break acceptance criteria into concrete steps; bounce on any
   AC that requires inference the ticket doesn't state.
3. **Red** — write a failing test per AC, confirm it fails for the right
   reason, commit tests before any implementation.
4. **Green** — implement the minimum change to pass, touching only the
   files the ticket's Scope section names.
5. **Verify** — full suite must be green; spawns `qa-agent` (see below) for
   a fresh-context adversarial pass, up to 3 retry loops.
6. **PR** — push the branch, open the PR, write `verdict.json`.

Core rule: this skill **never edits the spec**. Any ambiguity, contradiction,
or oversized scope is `research-loop`'s problem to fix upstream — this skill
bounces with evidence instead of guessing.

## qa-agent

`.claude/agents/qa-agent.md` — a genuinely fresh-context subagent spawned
during Verify. It sees only the ticket key and branch name — never the
implementer's reasoning — and checks: AC satisfaction, scope discipline
(no files touched beyond what Scope names), regressions, test quality, and
unrelated diff noise. Returns `pass`/`fail` plus concrete findings the
implementer can act on.

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
