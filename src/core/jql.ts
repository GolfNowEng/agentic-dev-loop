// Builds resolved JQL strings from a role's pollJql template (core/config.ts
// roleView). Pure string-building - no Jira calls here. Every value
// interpolated here is validated: labels/statuses by validateConfig, the
// assignee account id and ticket keys here.

import type { RoleView } from "./types.ts";

/** Jira Cloud account ids, e.g. "712020:0a1b2c3d-...". */
const ACCOUNT_ID = /^[A-Za-z0-9:_-]+$/;

/** A Jira issue key, e.g. "TARS-1465" (plan Global Constraints). */
export const TICKET_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/**
 * Fill a role's pollJql template: {label} (the role's triggerLabel),
 * {repoLabel}, {assignee}, {bouncedStatus}, {prOpenStatus}. Throws on any
 * other `{name}` left in the template, and on an assignee id that is not a
 * Jira account id. Substitution is a single pass, so a `{...}` inside a
 * substituted value is never re-expanded.
 */
export function buildPollJql(view: RoleView, vars: { assigneeAccountId: string }): string {
  if (!ACCOUNT_ID.test(vars.assigneeAccountId)) {
    throw new Error(
      `buildPollJql: the assignee account id must match ${ACCOUNT_ID} (check JIRA_ASSIGNEE_ACCOUNT_ID); got ${JSON.stringify(vars.assigneeAccountId)}`,
    );
  }
  const values: Record<string, string> = {
    label: view.triggerLabel,
    repoLabel: view.repoLabel,
    assignee: vars.assigneeAccountId,
    bouncedStatus: view.statusNames.bounced,
    prOpenStatus: view.statusNames.prOpen,
  };
  return view.pollJql.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`buildPollJql: pollJql has a placeholder this builder does not fill: ${whole}`);
    }
    return value;
  });
}

/**
 * Append `AND key not in (...)` to a JQL string, before any ORDER BY, so a
 * poll can skip tickets the loop has already decided not to run (dev's
 * landed-ticket guard, research's already-landed skip). Returns the JQL
 * unchanged when there is nothing to exclude. Throws on a key that is not a
 * Jira issue key, so nothing but a key is ever interpolated.
 */
export function excludeKeysFromJql(jql: string, keys: string[]): string {
  if (keys.length === 0) return jql;
  for (const k of keys) {
    if (!TICKET_KEY.test(k)) {
      throw new Error(`excludeKeysFromJql: not a Jira ticket key: ${JSON.stringify(k)}`);
    }
  }
  const clause = `key not in (${keys.map((k) => `"${k}"`).join(",")})`;
  const orderBy = /\s+order\s+by\s/i.exec(jql);
  if (!orderBy) return `${jql} AND ${clause}`;
  return `${jql.slice(0, orderBy.index)} AND ${clause}${jql.slice(orderBy.index)}`;
}
