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
  return config.jira.pollJql.refine
    .replace("{label}", config.jira.triggerLabel)
    .replace("{repoLabel}", config.jira.repoLabel);
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
  return config.jira.pollJql.dev
    .replace("{label}", config.jira.handoffLabel)
    .replace("{repoLabel}", config.jira.repoLabel);
}

/**
 * Append `AND key not in (...)` to a JQL string, before any ORDER BY, so a
 * poll can skip tickets the loop has already decided not to run. Returns
 * the JQL unchanged when there is nothing to exclude.
 */
export function excludeKeysFromJql(jql: string, keys: string[]): string {
  if (keys.length === 0) return jql;
  const clause = `key not in (${keys.map((k) => `"${k}"`).join(",")})`;
  const orderBy = /\s+order\s+by\s/i.exec(jql);
  if (!orderBy) return `${jql} AND ${clause}`;
  return `${jql.slice(0, orderBy.index)} AND ${clause}${jql.slice(orderBy.index)}`;
}
