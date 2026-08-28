# Changelog

Notable fixes and behavior changes to the research-loop pipeline itself
(`src/`, `.claude/skills/ticket-refine/`, `.claude/agents/`). Newest
first. Not every commit needs an entry — only ones that change what the
loop is capable of or fix a failure mode a human had to diagnose.

## 2026-08-27 — Formalized in-run self-heal vs. bounce in ticket-refine's Step 7

On a real `TARS-1284` run, Verify found 4 distinct defects in its own
synthesized spec (a mocked dependency missing a default resolved value
that would crash the first test on contact, an unreachable AC
assertion, an implicit value the code actually branches on, a vacuous
AC) and fixed all 4 in place across re-verify cycles, without ever
bouncing to a human. That behavior was correct but undocumented — Step
7 as written only described two outcomes, pass or bounce — so nothing
guaranteed a future run would draw the same line between "fix it myself"
and "this needs the human gate."

Added `#### Self-heal vs. bounce` to Step 7: a Verify failure is now
explicitly classified as **mechanical** (one derivable correct fix from
evidence already gathered this run — no tradeoff, no new investigation)
or **judgment-requiring** (a real design call, per the skill's own
"for the human gate, not a machine guess" principle — bounce as normal,
spend no retries on it). Mechanical failures self-heal and re-verify,
capped at 4 cycles per run; exceeding the cap without resolving is
itself evidence to bounce `spec_ambiguous` with all attempts attached.
Each self-heal cycle gets a distinct `progress.jsonl` line
(`"self-heal cycle <n>: ..."`) so a run that iterated internally is
distinguishable from one that passed clean, and the finalized comment /
`verdict.json` note the cycle count.

Moved from `docs/future-enhancements.md` (where this was logged as an
idea) — see that file's still-open cheap-tier-gate idea for the other
half of what came out of watching that run.

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
