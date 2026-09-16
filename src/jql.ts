// Builds resolved JQL strings from a Config's pollJql templates plus the
// jira.triggerLabel / jira.handoffLabel this repo's Config carries. Pure
// string-building - no Jira calls here.

import type { Config } from "./types.ts";

/**
 * Build the JQL used by the refine loop (Terminal A) to poll for tickets
 * carrying triggerLabel. Kept here (unused in this repo's own production
 * path) for the same test-symmetry reason research-loop keeps its own
 * unused-in-prod buildDevJql.
 */
export function buildRefineJql(config: Config): string {
  return config.jira.pollJql.refine.replace("{label}", config.jira.triggerLabel);
}

/**
 * Build the JQL used by the dev loop (Terminal B, this repo) to poll for
 * tickets carrying handoffLabel. `assigneeAccountId` fills the
 * `{assignee}` placeholder -- dev-loop only ever touches a ticket still
 * assigned to the configured human, since status no longer signals
 * "claimed" (see loop-runner.ts).
 */
export function buildDevJql(config: Config, assigneeAccountId: string): string {
  return config.jira.pollJql.dev
    .replace("{label}", config.jira.handoffLabel)
    .replace("{assignee}", assigneeAccountId);
}
