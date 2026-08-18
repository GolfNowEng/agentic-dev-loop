---
name: undefined
description: undefined
---

## Status

NOT YET IMPLEMENTED - this file is a placeholder scaffold only. No real
orchestration logic exists here yet.

## Intended behavior

This skill is expected to eventually drive a multi-phase run through the
dev-loop pipeline, in line with the phase list already tracked on a run's
verdict (`intake -> plan -> red -> green -> verify -> pr`):

1. **Intake** - accept a ticket key, load its acceptance criteria and any
   context the loop runner hands it, and confirm the ticket is actually
   ready to work.
2. **Plan** - break the acceptance criteria into an ordered list of
   concrete, testable steps before touching any code.
3. **Red** - for each acceptance criterion, write a failing test first and
   confirm it fails for the right reason.
4. **Green** - implement just enough to make the failing test(s) pass,
   without silently reinterpreting the spec.
5. **Verify** - run the full verification gates (build, lint, full test
   suite, etc.) and loop back through red/green as needed until they pass.
6. **PR** - open the pull request and write `verdict.json` with the final
   outcome, failure category (if any), and run metadata.

## Deferred

Full authorship of this skill - the actual prompts, tool usage, and
step-by-step instructions - is deferred to a follow-up task. This scaffold
only establishes that the skill directory and frontmatter exist.
