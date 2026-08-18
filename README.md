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
- The Jira client is a **stub that throws** until the placeholders in
  `pipeline.config.json` are filled in (see Appendix A of the spec, which is
  currently unfilled — every value in that file is the literal string
  `"___"`).
- The `ticket-to-pr` skill itself has **not been authored yet**. Only a stub
  `SKILL.md` exists at `.claude/skills/ticket-to-pr/SKILL.md`.

Do not expect this repo to run end-to-end yet. It builds and its existing
unit tests pass; the Jira integration and the actual ticket-to-PR skill are
still to come.

## Running tests

```sh
npm install && npm test
```
