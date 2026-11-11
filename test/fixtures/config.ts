// A fully valid v2 Config for tests. `patch` mutates a fresh deep copy, so
// each test states only the values it depends on.

import type { Config } from "../../src/core/types.ts";

const BASE: Config = {
  targetRepo: { url: "git@github.com:org/repo.git", defaultBranch: "main" },
  github: { repo: "org/repo" },
  jira: {
    repoLabel: "repo:org-repo",
    statusNames: { bounced: "Blocked", prOpen: "Code Review" },
    claimStatus: { from: "To Do", to: "In Progress" },
  },
  roles: {
    research: {
      triggerLabel: "pipeline:v2.0.0",
      handoffLabel: "pipeline:v2.0.0:dev",
      pollJql: 'labels = "{label}" AND labels = "{repoLabel}" AND status = "To Do" ORDER BY created ASC',
      ceilings: { maxCostPerRunUsd: 50, runTimeoutMin: 120 },
    },
    dev: {
      triggerLabel: "pipeline:v2.0.0:dev",
      pollJql:
        'labels = "{label}" AND labels = "{repoLabel}" AND status != "{bouncedStatus}" AND status != "{prOpenStatus}" ORDER BY created ASC',
      codeReviewFields: {
        piiField: "customfield_13504",
        piiNoImpactOptionId: "14310",
        qaNotesField: "customfield_14226",
      },
      ceilings: { maxCostPerRunUsd: 20, runTimeoutMin: 75 },
    },
  },
  ceilings: { maxRunsPerDay: 100, maxAttemptsPerTicket: 2, maxCostPerTicketUsd: 50 },
};

export function makeV2Config(patch: (c: Config) => void = () => {}): Config {
  const c = structuredClone(BASE);
  patch(c);
  return c;
}
