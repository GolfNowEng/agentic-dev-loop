// The shared context every reset step is built from.
import type { Config } from "../types.ts";
import type { JiraClient } from "../jira-client.ts";
import type { GitHubClient } from "../github-client.ts";
import type { SandboxAdapter } from "../../sandbox/types.ts";
import type { ResetRole } from "../reset-project.ts";

export interface ResetCtx {
  project: string;
  slug: string;
  ticket: string;
  role: ResetRole;
  config: Config | null;
  root?: string;
  jira: JiraClient | null;
  github: GitHubClient | null;
  openPrHeads: ((k: string) => Promise<{ head: string; url: string }[]>) | null;
  /** execFile git; rejects on non-zero. */
  git: (args: string[], cwd: string) => Promise<string>;
  sandbox: SandboxAdapter | null;
  sandboxConfig: unknown;
  isAlive?: (pid: number, started: number) => boolean;
  now: () => Date;
  closeRemote: boolean;
  /** --include-cross-role: archive records the other role landed in too. */
  includeCrossRole?: boolean;
}
