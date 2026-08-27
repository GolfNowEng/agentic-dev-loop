# Changelog

Notable fixes and behavior changes to the research-loop pipeline itself
(`src/`, `.claude/skills/ticket-refine/`, `.claude/agents/`). Newest
first. Not every commit needs an entry — only ones that change what the
loop is capable of or fix a failure mode a human had to diagnose.

## 2026-08-27 — Headless runs could stall forever on a Read permission prompt

`ALLOWED_TOOLS` in `src/main.ts` allowed `Bash` plus the specific
Atlassian MCP calls this skill uses, but never `Read`, `Grep`, or
`Glob`. `--permission-mode acceptEdits` only auto-approves `Edit`/
`Write`, not reads — and `Edit` itself refuses to touch a file that
hasn't been `Read` in-session first. So the moment `recon-agent` or
`ticket-refine`'s synthesis phase tried to edit a file it hadn't
already `cat`'d via `Bash`, it fell back to `Read`, hit an unanswerable
permission prompt (no human in a headless `-p` run), retried, and gave
up without ever writing `verdict.json`.

Not yet observed live in this repo, but confirmed as the same
mechanism that produced dev-loop's `agent_error` runs on TARS-1341,
TARS-1367, and TARS-1364 (see dev-loop's own `CHANGELOG.md`) — fixed
here preemptively for consistency, since both repos share this
composition-root pattern.

**Fix**: added `Read`, `Grep`, `Glob` to `ALLOWED_TOOLS` (`src/main.ts`).
