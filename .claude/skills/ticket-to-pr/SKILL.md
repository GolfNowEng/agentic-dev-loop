---
name: ticket-to-pr
description: Turns a ready Jira ticket into a PR (the executor role, spec section 5.0/5.2) - trusts the refined ticket completely, writes failing tests first, implements to green, verifies, then opens a PR.
---

## Status

NOT YET IMPLEMENTED - this file is a placeholder scaffold only. No real
orchestration logic exists here yet.

## Intended behavior

This skill drives a single ticket through the dev-loop's TDD-ordered
phases, matching the phase list tracked on a run's verdict
(`intake -> plan -> red -> green -> verify -> pr`):

1. **Intake** - accept a ticket key, read its description (the work order)
   and comments (extra context / human steering), and confirm the ticket
   is actually ready to work. No guessing: if a decision can't be reasoned
   to from the description + comments, bounce early rather than improvise.
2. **Plan** - break the acceptance criteria into an ordered list of
   concrete, testable steps before touching any code.
3. **Red** - for each acceptance criterion, write a failing test first and
   confirm it fails for the expected reason before writing implementation
   code. Record `red_confirmed: true` in the verdict.
4. **Green** - implement just enough to make the failing test(s) pass,
   touching only the files enumerated in the ticket, without silently
   reinterpreting the spec.
5. **Verify** - run the full existing suite (must stay green), confirm the
   new tests pass and are committed, then have a fresh-context QA agent
   attack the change.
6. **PR** - push the branch, open the pull request, and write
   `verdict.json` with the final outcome, failure category (if any), and
   run metadata.

Spec problems discovered mid-run (an AC is unimplementable, an enumerated
file doesn't exist, the described bug isn't reproducible) are never
patched over - the skill bounces with evidence, routing doubt back
upstream to `ticket-refine`.

## Deferred

Full authorship of this skill - the actual prompts, tool usage, and
step-by-step instructions - is deferred to a follow-up task. This scaffold
only establishes that the skill directory and frontmatter exist.
