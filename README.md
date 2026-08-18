# research-loop

This is the **Terminal A / research loop** repo of a local, two-terminal
agentic Jira pipeline:

- **research-loop** (this repo) refines raw Jira tickets into tickets marked
  ready for dev.
- **dev-loop** (the sibling repo) picks up "ready" tickets and lands PRs from
  them.

The two repos run as separate long-lived loops, each in its own terminal,
coordinating through Jira ticket state rather than through any direct
connection between the repos.

## Role: the skeptic

Per spec sections 5.0/5.1, this loop operates as "the skeptic." For each
ticket it pulls from Jira, it:

1. **Interprets** the ticket as written.
2. **Grounds** that interpretation against the actual codebase — checking
   that the ticket's assumptions match reality.
3. **Attacks** the ticket's assumptions, looking for gaps, ambiguity, or
   claims that don't hold up.
4. **Writes** the refined ticket, incorporating what it learned.

A passing verdict from this loop means the ticket is ready for the human
review gate — not ready for dev directly. Only after human review does a
ticket move to the "ready" epic that dev-loop consumes.

## Current status: structural scaffold

This repo is currently a **structural scaffold only**. Concretely:

- The loop-runner's pure functions — config loading, JQL query building,
  verdict parsing, ceiling enforcement, and run logging — are implemented
  and unit-tested.
- The Jira client is real (`RealJiraClient`) and fully bound for the
  `webtarsthree` project via `pipeline.webtarsthree.config.json`. Adding a
  second project means adding a second `pipeline.<project>.config.json` —
  see `docs/config.md`.
- `ticket-refine` (see `.claude/skills/ticket-refine/SKILL.md`) and its
  `recon-agent`, `devils-advocate-agent`, and `verifier-agent` subagents are
  fully authored.

Not yet built: a loop-runner CLI entrypoint that actually spawns `claude -p`
in a loop, and the live dashboard. See `docs/` for how the pieces fit
together, and `CLAUDE.md` for this repo's role and working rules.

## Running tests

```
npm install && npm test
```
