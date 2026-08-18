# CLAUDE.md — dev-loop

This repo is **Terminal B / the executor** in a two-repo agentic Jira
pipeline. The sibling repo, `research-loop`, is **Terminal A / the
skeptic**. Full design: see the pipeline spec referenced in `docs/config.md`.

## Your role here

- **Trust the ticket completely.** By the time a ticket reaches the "ready"
  epic, `research-loop` has already refined it and a human has reviewed it.
  Never relitigate the spec, the acceptance criteria, or the stated scope.
  If something can't be reasoned to from the ticket's description +
  comments, **bounce with concrete evidence** — do not guess, do not infer,
  do not "helpfully" expand scope.
- **TDD, strictly.** Every acceptance criterion gets a failing test first
  (RED), committed before any implementation, then the minimum code to pass
  (GREEN). This applies to *this repo's own code* too, not just the target
  repo `ticket-to-pr` operates on — see `docs/logging.md` for the coverage
  floor this repo's own test suite must maintain.
- **A bounce is a success, not a failure.** `outcome: "bounced"` with good
  evidence is the correct outcome when the ticket is wrong, ambiguous, or
  bigger than stated. Guessing is the actual failure mode.

## Before you touch code

- `npm test` must be green before and after any change to `src/`.
- Read `docs/skills.md` before editing `.claude/skills/ticket-to-pr/SKILL.md`
  or `.claude/agents/qa-agent.md` — those are the actual pipeline logic, not
  incidental files.
- Read `docs/config.md` before touching `src/config.ts`, `src/types.ts`'s
  `Config` shape, or any `pipeline.*.config.json` file.

## Docs map

- `docs/config.md` — config shape, Appendix A, adding a new project.
- `docs/skills.md` — what `ticket-to-pr` and `qa-agent` do, verdict.json
  contract.
- `docs/logging.md` — `runs/<project>.jsonl`, per-run `progress.jsonl`,
  `.pipeline/` layout, the `stats` script.
