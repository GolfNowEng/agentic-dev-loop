/**
 * Builds resolved JQL strings from a Config's pollJql templates plus the
 * epic ids configured in jira.intakeEpics / jira.readyEpic.
 *
 * The refine loop polls tickets sitting in the intake epics (candidates
 * for the skeptic pass). The dev loop polls tickets sitting in the ready
 * epic (candidates for dev-loop to pick up).
 */

import type { Config } from "./types.js";

/**
 * Build the JQL for the research-loop's own (refine/skeptic) poll, using
 * config.jira.pollJql.refine as a template and config.jira.intakeEpics as
 * the epics to search within.
 */
export function buildRefineJql(config: Config): string {
  const epics = config.jira.intakeEpics.join(", ");
  return config.jira.pollJql.refine.replace("{epics}", epics);
}

/**
 * Build the JQL for the dev-loop's poll, using config.jira.pollJql.dev as
 * a template and config.jira.readyEpic as the epic to search within.
 *
 * research-loop does not run this poll itself, but owns the config shape
 * dev-loop reads it from, so the builder lives here for symmetry and
 * testability.
 */
export function buildDevJql(config: Config): string {
  return config.jira.pollJql.dev.replace("{epic}", config.jira.readyEpic);
}
