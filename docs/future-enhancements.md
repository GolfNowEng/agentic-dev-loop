# Future Enhancements

Ideas for the pipeline itself (not tickets it processes) that are worth
doing but not yet drafted into a change. This is a holding pen: write down
the idea and the evidence behind it, then leave it for later. When one is
implemented, move its entry to `CHANGELOG.md` (if present) and delete it
from here.

## GitHub Issue + Projects board as pipeline state owner (Jira = product/planning only)

**Idea**: move pipeline execution state out of Jira and into GitHub. Jira
keeps the product/project side (the ticket, priority, description, fix
version, visibility for non-engineers). The mirror GitHub Issue owns
execution state (refining, bounced, awaiting approval, executing, PR open,
merged), shown as lanes on a GitHub Projects v2 board
(`fandango` org project 27, stock kanban template: Backlog / Ready /
In progress / In review / Done). Jira gets only coarse milestone
write-backs (refined, PR open, deployed) so it never goes stale. Builds on
the settled plan in `~/Desktop/pipeline-label-simplification.md` (one Jira
`pipeline` label, Issue as state owner, build phase 0 = create the 18
GitHub labels).

**Why**: Jira workflow transitions have required fields/screens/permissions
that break unattended runs; the Issue, branch and PR can't disagree when
state lives beside the code; GitHub Actions can drive lanes with no
pipeline code (PR opened -> In review, merged -> Done); Issue timelines
give an audit trail. A single-select Status also can't hold two states at
once, unlike stacked labels.

**Open points (not vetted)**: the stock lanes have none for bounced /
blocked / abandoned, so add Status options or keep a label/field for them.
One writer per fact: decide which system owns each field and make the
other read-only. Projects v2 items are separate from Issues (adding one is
a GraphQL call; moves need project/item/field/option ids). Reset and
re-refine paths (`reset-project`, "never re-refine") would need to read
state from the Issue. `gh` needs the `project` scope (done for
JustinChan-fd). Suggested order: labels first, board as a read-mostly view
that follows them, then move `src/` state reads/writes one transition at a
time (TDD). research-loop has the matching entry in its own
`docs/future-enhancements.md`.

**dev-loop specifics**: dev-loop is the executor, so the relevant
transitions are executing -> PR open -> merged and the poll step. Its
`loopKind: "dev"` poll has no atomic claim today; a board Status move (or
Issue assignee/label) could serve as the claim, which also helps the
N-instances-per-project idea tracked in research-loop's doc.
