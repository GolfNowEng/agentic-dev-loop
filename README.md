# dev-loop

This is the **Terminal B / dev loop** repo of a local, two-terminal agentic
Jira pipeline. The pipeline has two cooperating repos:

- **research-loop** ("Terminal A") refines raw Jira tickets down to a
  well-specified "ready" state.
- **dev-loop** (this repo, "Terminal B") picks up tickets that have reached
  "ready" and turns them into pull requests.

## Role: the executor

Per spec section 5.0/5.2, dev-loop operates as **the executor**:

- It trusts the refined ticket completely — the acceptance criteria are the
  contract, and dev-loop does not renegotiate them.
- For each acceptance criterion, it writes a failing test first (**RED**),
  then implements just enough to make it pass (**GREEN**).
- Once all criteria are green, it runs the verification gates (build, lint,
  full test suite, etc.) before opening a PR.
- dev-loop **never edits the spec**. If a ticket's spec is wrong, ambiguous,
  or unimplementable as written, dev-loop bounces the ticket back with
  concrete evidence (failing test output, contradiction, missing
  information) rather than silently reinterpreting it.

## Current status: structural scaffold only

This repo is currently a **structural scaffold**, not a working pipeline:

- The loop-runner's pure functions — config loading, JQL query building,
  verdict parsing, ceiling enforcement, and run logging — are implemented
  and unit-tested.
- The Jira client is real (`RealJiraClient`) and fully bound for the
  `webtarsthree` project via `pipeline.webtarsthree.config.json`. Adding a
  second project means adding a second `pipeline.<project>.config.json` —
  see `docs/config.md`.
- `ticket-to-pr` (see `.claude/skills/ticket-to-pr/SKILL.md`) and its
  `qa-agent` subagent are fully authored.

Not yet built: a loop-runner CLI entrypoint that actually spawns `claude -p`
in a loop, and the live dashboard. See `docs/` for how the pieces fit
together, and `CLAUDE.md` for this repo's role and working rules.

## Running tests

```sh
npm install && npm test
```
