/**
 * Jira access boundary for the research-loop.
 *
 * loop-runner.ts depends only on the JiraClient interface, never on a
 * concrete implementation -- tests inject a mock, and production wiring
 * (out of scope for this repo until Appendix A of the pipeline spec is
 * filled in) injects a real client.
 */

/**
 * Minimal description of a Jira ticket as the loop needs it. Kept narrow
 * deliberately -- the loop should not need full Jira field fidelity.
 */
export interface JiraTicket {
  key: string;
  status: string;
  epic: string | null;
  labels: string[];
}

export interface JiraClient {
  /**
   * Poll Jira via the given JQL and return the oldest matching ticket, or
   * null if nothing matches.
   */
  pollOldestMatching(jql: string): Promise<JiraTicket | null>;

  /**
   * Attempt to claim a ticket by transitioning it from claimStatus.from to
   * claimStatus.to. Returns true if the claim succeeded, false if it lost
   * a race (another process already transitioned it away from `from`) --
   * callers must treat false as "skip this ticket," never as an error to
   * throw.
   */
  claim(ticketKey: string, from: string, to: string): Promise<boolean>;

  /** Transition a ticket to the given status. */
  transitionStatus(ticketKey: string, toStatus: string): Promise<void>;

  /** Move a ticket to a different epic. */
  moveToEpic(ticketKey: string, epicKey: string): Promise<void>;
}

const UNCONFIGURED_MESSAGE = (method: string): string =>
  `JiraClient.${method}: Jira instance is not configured. ` +
  `Appendix A of the pipeline spec (pipeline.config.json epic IDs, ` +
  `statuses, and JQL) is still unfilled -- this needs real Jira binding ` +
  `values before any Jira call can be made.`;

/**
 * Placeholder JiraClient. Every method throws until pipeline.config.json's
 * "___" placeholders are replaced with real Jira values and a real client
 * is wired in. Exists so loop-runner.ts has something concrete to run
 * against outside of tests without silently pretending to talk to Jira.
 */
export class StubJiraClient implements JiraClient {
  async pollOldestMatching(_jql: string): Promise<JiraTicket | null> {
    throw new Error(UNCONFIGURED_MESSAGE("pollOldestMatching"));
  }

  async claim(_ticketKey: string, _from: string, _to: string): Promise<boolean> {
    throw new Error(UNCONFIGURED_MESSAGE("claim"));
  }

  async transitionStatus(_ticketKey: string, _toStatus: string): Promise<void> {
    throw new Error(UNCONFIGURED_MESSAGE("transitionStatus"));
  }

  async moveToEpic(_ticketKey: string, _epicKey: string): Promise<void> {
    throw new Error(UNCONFIGURED_MESSAGE("moveToEpic"));
  }
}
