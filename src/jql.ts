/**
 * Builds resolved JQL strings from a Config's pollJql templates plus the
 * jira.triggerLabel / jira.handoffLabel this repo's Config carries.
 *
 * The refine loop polls tickets carrying triggerLabel (candidates for the
 * skeptic pass). The dev loop polls tickets carrying handoffLabel
 * (candidates for dev-loop to pick up).
 */

import type { Config } from "./types.ts";

/**
 * Build the JQL for the research-loop's own (refine/skeptic) poll, using
 * config.jira.pollJql.refine as a template and config.jira.triggerLabel as
 * the label to match.
 */
export function buildRefineJql(config: Config): string {
  return config.jira.pollJql.refine.replace("{label}", config.jira.triggerLabel);
}

/**
 * Build the JQL for the dev-loop's poll, using config.jira.pollJql.dev as
 * a template and config.jira.handoffLabel as the label to match.
 *
 * research-loop does not run this poll itself, but owns the config shape
 * dev-loop reads it from, so the builder lives here for symmetry and
 * testability.
 */
export function buildDevJql(config: Config): string {
  return config.jira.pollJql.dev.replace("{label}", config.jira.handoffLabel);
}
