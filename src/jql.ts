// Builds resolved JQL strings from a Config's pollJql templates plus the
// intake/ready epic lists. Pure string-building - no Jira calls here.

import type { Config } from "./types.ts";

/**
 * Build the JQL used by the refine loop (Terminal A) to poll for tickets
 * still sitting in one of the intake epics.
 */
export function buildRefineJql(config: Config): string {
  const epics = config.jira.intakeEpics.join(", ");
  return config.jira.pollJql.refine.replace("{epics}", epics);
}

/**
 * Build the JQL used by the dev loop (Terminal B, this repo) to poll for
 * tickets that have reached the ready epic. `assigneeAccountId` fills the
 * `{assignee}` placeholder -- dev-loop only ever touches a ticket still
 * assigned to the configured human, since status no longer signals
 * "claimed" (see loop-runner.ts).
 */
export function buildDevJql(config: Config, assigneeAccountId: string): string {
  return config.jira.pollJql.dev
    .replace("{readyEpic}", config.jira.readyEpic)
    .replace("{assignee}", assigneeAccountId);
}
