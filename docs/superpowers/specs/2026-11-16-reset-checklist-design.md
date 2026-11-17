# Reset to zero: one checklist, one approval

Date: 2026-11-16. Status: approved 2026-11-16.

## Why

On 2026-11-16, TARS-1634 was reset and rerun about six times while the sbx
adapter was being tested. Most of the failed reruns were not loop bugs. They
were reset steps done by hand, separately and out of step with each other:

- the local reset ran, but Jira's label or status wasn't changed;
- a research comment was deleted by hand, so dev bounced with no spec;
- a dead session lock still named the stopped run, so the rerun "resumed" it
  and exited;
- a git worktree entry was left behind, so the branch couldn't be deleted;
- a 10-minute "recently ended" hold kept the rerun idle, with no message.

Each one cost a run, plus time spent working out why. The aim is that
resetting a ticket is one command, the human sees everything it will do
before it does anything, and afterwards the ticket really is at zero.

## What it is

`npm run reset-project -- --project=<p> --ticket=<KEY> [--role=research|dev|all]`
becomes a checklist runner:

1. **Survey (read-only).** It reads what earlier runs on the ticket actually
   touched, and checks the live state of each thing: local files, the target
   repo's git, Jira, GitHub and the sandbox adapter.
2. **Table.** It prints one table: one row per checklist step, what it found,
   and what it will do.
3. **Approve.** It asks `Proceed? [y/N]`. Anything but `y`/`yes` exits with
   nothing changed. `--dry-run` prints the table and exits without asking.
4. **Execute.** It runs the approved steps in a fixed order, each one on its
   own, so one failing doesn't stop the rest.
5. **Verify.** It re-surveys and prints a final table, ending in either
   `TARS-1634 is at zero` or the list of steps that still need a human.

### The table

Illustrative (a sandboxed dev run that was stopped mid-way):

```
Reset TARS-1634 (role: all)

 #  Area      Step                         Found                                Action
 1  local     run records                  3 records in runs/v2/webtarsthree    archive 3
 2  local     run dirs                     research-…, dev-20261117T035443Z     delete 2
 3  local     session lock in-flight       dev-1.lock (holder dead) -> dev run  clear
 4  git       worktrees                    TARS-1634-20261117T035443Z           remove + prune
 5  git       local branches               TARS-1634-okta-docs-stale (0 ahead)  delete
 6  git       pushed branches / PRs        none                                 -
 7  jira      status                       Blocked                              move to To Do
 8  jira      label                        pipeline:v2:dev                      swap to pipeline:v2
 9  jira      loop comments                2 (1 research, 1 dev)                delete 2
10  jira      follow-up tickets            none                                 -
11  github    mirror Issue                 #585 (closed, not planned)           keep (research reads it as context)
12  sandbox   leftover sandboxes           none                                 -

Proceed? [y/N]
```

A step with nothing to do shows `-` and is skipped. A step that is unsafe
to do automatically shows `needs you: <why>`; it is listed, never acted on.

### Each step

Each step has a **survey** (read-only, returns "found" and the proposed
action), an **execute**, and a **verify** (the survey run again: "found"
must now be clean). A role-scoped reset (`--role=research` or `dev`) runs
only the steps and items that belong to that role, and never touches the
other role's comment, records or label.

| Area | Step | Role | What "at zero" means | Never |
|---|---|---|---|---|
| local | run records | per role | No v2 record for the role; archived, not deleted (as today) | touch v1 history |
| local | run dirs | per role | No `<role>-*` dir for the ticket | |
| local | session lock in-flight | per role | No dead lock names the ticket and role | rewrite a live holder's lock |
| local | recent-window hold | per role | No record holds the ticket back from the next poll | |
| git | worktrees | per role | No `<TICKET>-*` worktree, and git's list pruned | |
| git | local branches | dev | No local `<TICKET>-*` branch | delete one that is pushed or has an open PR |
| git | pushed branches / PRs | dev | Listed | delete or close (only `--close-remote` does, after confirmation) |
| jira | status | both | The research trigger status (To Do) for `all`/`research`; for `dev` the status the dev poll picks up | |
| jira | label | both | `all`/`research`: the research trigger label; `dev`: the dev trigger (handoff) label | add or remove any other label |
| jira | loop comments | per role | No comment the loop posted for the role | delete a comment the loop didn't post |
| jira | follow-up tickets | dev | Listed (from `follow_up` in dev verdicts) | delete or close them |
| github | mirror Issue | research | Closed as not planned (reported only; research won't reuse it) | edit or delete it |
| sandbox | leftover instances | both | No instance for the ticket (`dl-…-<ticket>-…`) | change network policy or secrets |

**Loop comments** are recognised by their prefix: `✅ research-loop`,
`❌ research-loop`, `✅ dev-loop`, `❌ dev-loop` (and any other prefix the
skills post today, listed in one place in code). Comments by people are
never deleted.

**Mirror Issue (decided by the user).** Reset leaves the Issue alone; the
row only reports it. Research changes instead: an Issue closed as
"not planned" is never reused as the run's mirror and never makes the run a
re-pickup. Research creates a fresh Issue, and reads the closed one as
**prior context**: what the earlier run found, and why it was reset. It is
treated as an unverified claim like the raw ticket (stance.md), not as a
spec to copy. The new Issue links the old one ("Previous attempt: #585").

### Where the steps live (the connections pattern)

Each area owns its steps, so a new connector or adapter brings its own reset
steps and reset can't drift behind:

- `local` and `git`: in `src/core/reset/`.
- `jira` and `github`: next to their clients.
- `sandbox`: a new optional method on `SandboxAdapter`,
  `resetSteps?(ticket, config)`. sbx implements it; `none` has none.

Reset collects every area's steps, runs the surveys, prints the table. The
`src/connections/<name>/` folder layout is not required for this. If it lands
later, the steps move with their connection.

### Ordering and safety

- A live worker holding the project's session lock refuses the whole reset
  (as today; `--ignore-live-worker` still overrides).
- Execute order: sandbox, then git, then local, then Jira and GitHub last.
  The ticket only becomes pollable (To Do + trigger label) once everything
  else is clean, so a worker started mid-reset can't pick up a half-reset
  ticket.
- Every step re-checks its own state just before acting (as the lock step
  does today).
- Credentials: the survey needs Jira and GitHub, so reset always loads the
  env file (today only `reset-project:remote` does). With no credentials, the
  Jira and GitHub rows show `needs you: no credentials` and the local and git
  steps still run.

### Approval

- One prompt, after the table: `Proceed? [y/N]`. Default no.
- No TTY (piped, CI, or an agent's shell): reset refuses to act without
  `--yes`. An agent must show the user the table and get a yes in chat before
  rerunning with `--yes`; the reset-project skill says so.
- `--close-remote` keeps its own meaning (close the ticket, Issue and PR, not
  reset them). It appears as extra rows in the same table, under the same
  approval.

## Goals

- One command takes a ticket back to zero, for either role or both.
- The human sees every change, local and remote, before any of it happens.
- After a reset, the next run behaves exactly like a first pickup.
- Each step verifies itself; the final table says whether the ticket is at zero.

## Non-goals

- Closing or deleting anything other people work with: pushed branches, PRs,
  follow-up tickets. Those are listed only (`--close-remote` still closes the
  ticket, Issue and PR, after confirmation).
- Changing the sandbox's network policy or secrets.
- Whole-project resets. They keep today's behaviour; the checklist is
  per-ticket.

## Anti-goals

- A reset that says it worked when something was left behind.
- Deleting a human's comment, branch or ticket.
- A reset that needs a second, manual step to "really" work.

## Related fixes in the same change

- **Recent-window hold:** shorten it from 10 minutes to 2, apply it only to
  records whose run changed the ticket's Jira status, and print one line when
  it skips a ticket ("TARS-1634 skipped: a run on it ended 1m ago").
- **Stale branches:** the git step also sweeps the 7 stale TARS-1618
  worktrees and branches left on webtarsthree when that ticket is reset
  (they are an example, not special-cased).

## Decisions settled after the builder check

- **New client methods.** `JiraClient` gains `listComments`, `deleteComment`
  and `getLabels` (REST, plus the stubs). `GitHubClient` needs no write, only
  reading the Issue's state and close reason.
  If Jira refuses a delete (permission), that row reports `needs you` with
  the comment's link; the rest carry on.
- **Which comments are the loop's (decided by the user).** The loop posts
  with the user's own Jira credentials, so the author can't tell them apart.
  A comment is the loop's when it was **created during one of the ticket's
  recorded runs** of the role being reset: between that run's `started` and
  `ended` (plus 2 minutes' slack for a write at the very end), read from the
  run records, including the reset archive, before anything is archived.
  It must also start with a known loop prefix; the prefixes live in one
  exported list in code. A run with no `ended` (stopped mid-way) uses its
  run dir's last `progress.jsonl` timestamp. A comment outside every run
  window is never deleted, whatever it says; the table lists each comment
  it will delete (time and first line), so the y/n prompt is the last check.
- **Target status and labels come from config:**
  - `all` / `research`: status `roles.research.claimStatus.from` (To Do),
    label `roles.research.triggerLabel`; the handoff label removed.
  - `dev`: status `roles.research.claimStatus.from` (the dev poll excludes
    only the bounced and PR-open statuses, so To Do is picked up), label
    `roles.research.handoffLabel` (= the dev trigger); the research label
    removed if present. Research's comment and records are kept.
  - Done once per reset, not per role.
- **What the survey reads.** Local and git rows come from the files; Jira,
  GitHub and sandbox rows are always checked live, whatever the records say.
  A dirty Jira ticket with no local record is still reset.
- **Recent-window hold:** runs records gain `jira_status_changed: true` when
  the run transitioned the ticket. The hold applies only to those, for 2
  minutes. Archiving the run records (step 1) also clears the hold, so the
  hold row is a check, not an extra action.
- **Stale branches:** only the ticket being reset (`<TICKET>-*`). The
  TARS-1618 leftovers are cleaned by resetting TARS-1618.
- **Git safety:** branches are checked against `origin` with
  `git ls-remote`, and against open PRs with `gh`. A local branch is deleted
  only when it is not on origin, has no open PR, and is 0 commits ahead of
  `origin/<defaultBranch>`. A branch with unpushed commits is `needs you`. If
  the remote check fails, every branch row is `needs you`. The repo is
  `targetRepo.path` (else the v2 clone), as for worktrees today.
- **`--close-remote`:** replaces the Jira status/label/comment rows with the
  close rows (closing, not resetting); the local, git and sandbox rows run
  as usual.
- **Whole-project resets:** unchanged, including the `--yes` requirement.
- **Exit codes:** declined or `--dry-run`: 0, nothing changed, no verify.
  After execute: 0 only when the final table is at zero, else 1.

## Left to the builder

- Table rendering (plain fixed-width text is fine).
- Exact module names and how steps are registered.
- How research's skill reads and summarises the closed Issue (within the
  stance's rules).
