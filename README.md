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
- The **Jira client is a stub that throws** until the placeholders in
  `pipeline.config.json` (Appendix A of the spec) are filled in with real
  epic IDs, statuses, and JQL.
- The **`ticket-refine` skill itself has not been authored yet** — only a
  stub `SKILL.md` exists at `.claude/skills/ticket-refine/SKILL.md`. It does
  not perform any refinement yet.

In short: the scaffolding and tested plumbing exist, but the loop cannot yet
talk to Jira or actually refine a ticket end to end.

## Running tests

```
npm install && npm test
```
