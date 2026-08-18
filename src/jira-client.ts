// Jira client boundary. The loop runner depends only on this interface, so
// tests can inject a mock instead of touching real Jira.
//
// Appendix A of the pipeline spec (the concrete Jira instance/binding
// values: base URL, auth, status IDs, epic link field, etc.) is currently
// unfilled - pipeline.config.json has every value set to the literal
// string "___". Until that's filled in there is no real Jira to bind to,
// so StubJiraClient throws on every call.

export interface JiraTicket {
  key: string;
  status: string;
  epic: string | null;
}

export interface JiraClient {
  /**
   * Poll Jira for the oldest ticket matching the given JQL. Returns null
   * if no ticket matches.
   */
  pollOldestMatching(jql: string): Promise<JiraTicket | null>;

  /**
   * Attempt to atomically claim a ticket by transitioning it from one
   * status to another. Returns false (never throws) if the transition
   * failed because another process raced it and already moved the
   * ticket - the caller should skip this ticket and continue, not treat
   * that as an error.
   */
  claimTicket(ticketKey: string, from: string, to: string): Promise<boolean>;

  /**
   * Transition a ticket to a new status (not a claim - used for
   * post-run outcome transitions such as marking a ticket "bounced" or
   * moving it toward "landed").
   */
  transitionStatus(ticketKey: string, to: string): Promise<void>;

  /**
   * Move a ticket to a different epic (e.g. from an intake epic to the
   * review epic, or from the review epic to the ready epic).
   */
  moveToEpic(ticketKey: string, epic: string): Promise<void>;
}

/**
 * Stand-in JiraClient used until Appendix A of the pipeline spec is
 * filled in with real Jira binding values (base URL, auth, status IDs,
 * epic link field, etc.). Every method throws a clear, actionable error
 * rather than silently doing nothing or hitting a real API.
 */
export class StubJiraClient implements JiraClient {
  private static notConfigured(method: string): Error {
    return new Error(
      `StubJiraClient.${method}: Jira instance is not configured. ` +
        `Appendix A of the pipeline spec is unfilled (pipeline.config.json ` +
        `still has placeholder "___" values) - this needs real Jira ` +
        `binding values (base URL, auth, status IDs, epic link field, etc.) ` +
        `before ${method} can do anything real.`,
    );
  }

  async pollOldestMatching(_jql: string): Promise<JiraTicket | null> {
    throw StubJiraClient.notConfigured("pollOldestMatching");
  }

  async claimTicket(
    _ticketKey: string,
    _from: string,
    _to: string,
  ): Promise<boolean> {
    throw StubJiraClient.notConfigured("claimTicket");
  }

  async transitionStatus(_ticketKey: string, _to: string): Promise<void> {
    throw StubJiraClient.notConfigured("transitionStatus");
  }

  async moveToEpic(_ticketKey: string, _epic: string): Promise<void> {
    throw StubJiraClient.notConfigured("moveToEpic");
  }
}
