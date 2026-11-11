# CLAUDE.md — dev-loop

One repo, two phases of an agentic Jira pipeline, selected with
`--phase research|dev`. Each phase has its own stance. Apply the stance of the
phase/skill you are working in, not the other.

## Research phase (`ticket-refine`, run from `research-loop/`)

The stance lives in `research-loop/CLAUDE.md`; research spawns load that file
and exclude this one.

- **Treat every raw ticket as an unverified claim.** Produce a ticket a
  literal-minded Sonnet-tier implementer can execute without asking a question,
  or bounce it with concrete evidence of why it isn't ready.
- Ground claims against the actual codebase (`recon-agent`), attack your own
  assumptions (`devils-advocate-agent`), and verify independently
  (`verifier-agent`).

## Dev phase (`ticket-to-pr`, `qa-agent`)

- **Trust the ticket completely.** By the time a ticket reaches the "ready"
  epic it has been refined and human-reviewed. Never relitigate the spec,
  acceptance criteria, or scope. If something can't be reasoned to from the
  ticket's description + comments, **bounce with concrete evidence** — do not
  guess, infer, or "helpfully" expand scope.
- **TDD, strictly.** Every acceptance criterion gets a failing test first
  (RED), committed before any implementation, then the minimum code to pass
  (GREEN).

## Both phases

- **A bounce is a success, not a failure.** `outcome: "bounced"` with good
  evidence is correct. Guessing is the actual failure mode.
- TDD applies to this repo's own code too. `npm test`, `npm run test:hooks`
  and `npx tsc --noEmit` must be green before and after any change to `src/`
  or `.claude/hooks`.

## Before you touch code

- Read `docs/skills.md` before editing `.claude/skills/*/SKILL.md` or
  `.claude/agents/*.md` — those are the actual pipeline logic.
- Read `docs/config.md` before touching `src/core/config.ts`, the `Config`
  shape in `src/core/types.ts`, or any `pipeline.*.config.json` file.

## Docs map

Each doc has `## Research phase` and `## Dev phase` sections.

- `docs/config.md` — config shape, Appendix A, adding a new project.
- `docs/skills.md` — what each phase's skills and subagents do, verdict.json contract.
- `docs/logging.md` — `runs/<project>.jsonl`, per-run `progress.jsonl`,
  `.pipeline/` layout, the `stats` script.
- `docs/reset.md` — `npm run reset-project`; use it to start a ticket or project
  fresh instead of hand-rolling `rm -rf`/`grep -v`.
- `docs/future-enhancements.md` — ideas not yet drafted into a change. When one
  lands, move it to `CHANGELOG.md` and delete it here.
- `docs/migration-ledger.md` — every divergence resolved when merging the two repos.
- `CHANGELOG.md` — fixes/behavior changes to the pipeline itself (not the tickets
  it processes). Add an entry whenever you fix a bug a human had to diagnose
  from a real run. Tag each bullet `[core]`, `[research]`, `[dev]` or `[hooks]`.
  Pre-2.0.0 history: `docs/changelog/`.
- `docs/superpowers/` — dated specs and plans.
