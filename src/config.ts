// Loads and validates pipeline.config.json.
//
// This is a thin, pure-ish loader: read the file, parse it, hand back a
// typed Config. It does not resolve "___" placeholders -- callers that need
// a fully-bound config (e.g. RealJiraClient) are responsible for checking
// for placeholder values themselves and failing loudly if any remain.

import { readFile } from "node:fs/promises";
import type { Config } from "./types.js";

/**
 * Read and parse pipeline.config.json from the given path (defaults to
 * "./pipeline.config.json" relative to cwd). Throws if the file is
 * missing or not valid JSON -- a broken config file should fail loudly at
 * startup, not be silently tolerated.
 */
export async function loadConfig(path = "./pipeline.config.json"): Promise<Config> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Config;
}

/** Field paths (dot-notation) worth checking for leftover "___" placeholders. */
const PLACEHOLDER_PATHS: Array<[string, (c: Config) => unknown]> = [
  ["jira.reviewEpic", (c) => c.jira.reviewEpic],
  ["jira.readyEpic", (c) => c.jira.readyEpic],
  ["jira.claimStatus.from", (c) => c.jira.claimStatus.from],
  ["jira.claimStatus.to", (c) => c.jira.claimStatus.to],
  ["jira.pollJql.refine", (c) => c.jira.pollJql.refine],
  ["jira.pollJql.dev", (c) => c.jira.pollJql.dev],
  ["jira.epicLinkField", (c) => c.jira.epicLinkField],
  ["jira.statusNames.bounced", (c) => c.jira.statusNames.bounced],
  ["jira.statusNames.prOpen", (c) => c.jira.statusNames.prOpen],
  ["autoPromoteLabel", (c) => c.autoPromoteLabel],
];

/**
 * List which known config fields still hold the literal placeholder value
 * "___" (Appendix A of the pipeline spec not yet filled in). Empty array
 * means the config is fully bound.
 */
export function findPlaceholders(config: Config): string[] {
  return PLACEHOLDER_PATHS.filter(([, get]) => get(config) === "___").map(
    ([path]) => path,
  );
}

/** Throws a clear error naming every field still set to "___", if any. */
export function assertNoPlaceholders(config: Config): void {
  const missing = findPlaceholders(config);
  if (missing.length > 0) {
    throw new Error(
      `pipeline.config.json still has placeholder "___" values for: ${missing.join(", ")}. ` +
        `Fill in Appendix A of the pipeline spec before using RealJiraClient.`,
    );
  }
}
