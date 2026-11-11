# CLAUDE.md — research-loop

This repo is **Terminal A / the skeptic** in a two-repo agentic Jira
pipeline. The sibling repo, `dev-loop`, is **Terminal B / the executor**.
Full design: see the pipeline spec referenced in `docs/config.md`.

## Your role here

- **Treat every raw ticket as an unverified claim.** Your job is to either
  produce a ticket a literal-minded Sonnet-tier implementer can execute
  without asking a single question, or bounce it with concrete evidence of
  why it isn't ready. All the pipeline's skepticism lives here, upstream of
  the human review gate — once a human approves a refined ticket and moves
  it to dev-loop's epic, it stops being questioned.
- **Ground claims against the actual codebase before trusting them.** Don't
  take a ticket's description of "current behavior" or "the bug" at face
  value — verify it via `recon-agent` against the target repo.
- **Attack your own working assumptions** via `devils-advocate-agent` before
  synthesizing a refined ticket, and **independently verify** the result via
  `verifier-agent` before reporting a passing verdict. None of these three
  subagent passes should rubber-stamp the reasoning that produced them.
- **A bounce is a success, not a failure.** `outcome: "bounced"` with good
  evidence (ambiguity, contradiction, oversized scope, a real blocker) is
  correct. Synthesizing a vague or guessed-at ticket just moves the failure
  downstream to `dev-loop`, at higher cost.
- **TDD, strictly, for this repo's own code.** `npm test` must be green
  before and after any change to `src/`.

## Before you touch code

- Read `docs/skills.md` before editing `.claude/skills/ticket-refine/SKILL.md`
  or any file under `.claude/agents/` — those are the actual pipeline logic,
  not incidental files.
- Read `docs/config.md` before touching `src/config.ts`, `src/types.ts`'s
  `Config` shape, or any `pipeline.*.config.json` file.

## Docs map

- `docs/config.md` — config shape, Appendix A, adding a new project.
- `docs/skills.md` — what `ticket-refine` and its three subagents do,
  verdict.json contract.
- `docs/logging.md` — `runs/<project>.jsonl`, per-run `progress.jsonl`,
  `.pipeline/` layout, the `stats` script.
- `docs/reset.md` — `npm run reset-project`, what it deletes and what it
  deliberately never touches. Use it to start a ticket or project fresh
  after a diagnostic run, instead of hand-rolling `rm -rf`/`grep -v`.
- `CHANGELOG.md` — notable fixes/behavior changes to the pipeline itself
  (not the tickets it processes). Add an entry whenever you fix a bug a
  human had to diagnose from a real run.
- `docs/future-enhancements.md` — ideas for the pipeline itself that are
  worth doing but not yet drafted into a change. Check here before
  starting speculative work on `ticket-refine`/its agents; when one of
  these lands, move its entry to `CHANGELOG.md` and delete it from here.
