export type ResetArea = "local" | "git" | "jira" | "github" | "sandbox";
export const AREA_ORDER: readonly ResetArea[] = ["sandbox", "git", "local", "jira", "github"];

export interface Survey {
  found: string; // short, one line ("none" when empty)
  action: string | null; // null renders "-"
  needsYou?: string; // set => never run, row shows "needs you: <why>"
  details?: string[]; // extra indented lines under the row
  run?: () => Promise<void>; // present iff action !== null && !needsYou
}

export interface ResetStep {
  area: ResetArea;
  name: string;
  survey(): Promise<Survey>;
  /**
   * Its run makes the ticket pollable again (the Jira status move). The
   * runner runs it last, and only when no other row needs the person, errored
   * or failed: a half-reset ticket never goes back on the poll.
   */
  makesPollable?: boolean;
}

// `error` records a failed survey or failed run; such a row is never at zero.
export interface SurveyedRow {
  step: ResetStep;
  survey: Survey;
  error?: string;
}

export function atZero(row: SurveyedRow): boolean {
  return !row.error && row.survey.action === null && !row.survey.needsYou;
}
