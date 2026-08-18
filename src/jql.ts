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
 * tickets that have reached the ready epic.
 */
export function buildDevJql(config: Config): string {
  return config.jira.pollJql.dev.replace("{readyEpic}", config.jira.readyEpic);
}
