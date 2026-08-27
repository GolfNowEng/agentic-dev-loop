# Changelog

Notable fixes and behavior changes to the dev-loop pipeline itself
(`src/`, `.claude/skills/ticket-to-pr/`, `.claude/agents/qa-agent.md`).
Newest first. Not every commit needs an entry — only ones that change
what the loop is capable of or fix a failure mode a human had to
diagnose.

## 2026-08-27 — Headless runs could stall forever on a Read permission prompt

`ALLOWED_TOOLS` in `src/main.ts` allowed `Bash` plus two Atlassian MCP
calls, but never `Read`, `Grep`, or `Glob`. `--permission-mode
acceptEdits` only auto-approves `Edit`/`Write`, not reads — and `Edit`
itself refuses to touch a file that hasn't been `Read` in-session first.
So the moment `ticket-to-pr` tried to edit a file it hadn't already
`cat`'d via `Bash`, it fell back to `Read`, hit an unanswerable
permission prompt (no human in a headless `-p` run), retried a few
times, and gave up without ever writing `verdict.json`.

Surfaced on `TARS-1341` (stuck retrying a `Read` on
`serverFetch.test.js` mid-Red-phase, three runs total once two
subsequent polls piled up and correctly bounced on the collision) but
had already caused the identical `agent_error` / "no run directory
appeared" signature on `TARS-1367` and four times in a row on
`TARS-1364` earlier — this was a recurring, intermittent failure, not a
one-off.

**Fix**: added `Read`, `Grep`, `Glob` to `ALLOWED_TOOLS` (`src/main.ts`).
