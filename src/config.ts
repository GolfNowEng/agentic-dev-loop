// Loads and validates pipeline.config.json.
//
// This is a thin, pure-ish loader: read the file, parse it, hand back a
// typed Config. It does not resolve "___" placeholders -- callers that need
// a fully-bound config (e.g. RealJiraClient) are responsible for checking
// for placeholder values themselves and failing loudly if any remain.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config, LoopConfig } from "./types.ts";

/**
 * Read and parse a pipeline config file at the given path. There is no
 * default path: with multiple projects (each its own
 * "pipeline.<repo-slug>.config.json"), an implicit default would silently
 * couple this loader to one project. Throws if the file is missing or not
 * valid JSON -- a broken config file should fail loudly at startup, not be
 * silently tolerated.
 */
export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Config;
}

/**
 * Read and parse pipeline.loop.config.json -- loop-mechanics settings, not
 * project wiring, so (unlike loadConfig) there's no multi-project ambiguity
 * to guard against: a plain default path is fine. `path` defaults to
 * "pipeline.loop.config.json" in the current working directory.
 */
export async function loadLoopConfig(
  path: string = "pipeline.loop.config.json",
): Promise<LoopConfig> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as LoopConfig;
}

/**
 * Derive a filesystem-safe project slug from a target repo's git remote
 * URL, e.g. "webtarsthree" from "git@github.com:fandango/webtarsthree.git"
 * or "https://github.com/fandango/webtarsthree". Used to namespace
 * per-project paths (runs log, `.pipeline/` workdir) so multiple projects'
 * configs can coexist in one pipeline repo without collisions.
 */
export function repoSlugFromUrl(url: string): string {
  const withoutGitSuffix = url.replace(/\.git$/, "");
  const lastSegment = withoutGitSuffix.split(/[/:]/).pop();
  if (!lastSegment) {
    throw new Error(`repoSlugFromUrl: could not derive a slug from "${url}".`);
  }
  return lastSegment;
}

/**
 * List available project names at `dir` (repo root by default): every
 * "pipeline.<name>.config.json" file present, minus
 * "pipeline.loop.config.json" (loop-mechanics, not a project). Returns an
 * empty array if `dir` doesn't exist or has no matching files -- never
 * throws, since this is only ever used to build a human-readable error
 * listing for --project.
 */
export async function listAvailableProjects(dir: string = "."): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .map((name) => /^pipeline\.(.+)\.config\.json$/.exec(name)?.[1])
    .filter((name): name is string => name !== undefined && name !== "loop")
    .sort();
}

/**
 * Resolve a --project name to its "pipeline.<name>.config.json" path at
 * `dir` (repo root by default). Throws a clear, synchronous error listing
 * the actually-available projects if `projectName` is omitted, or if no
 * config file exists for it -- this runs before any Jira/GitHub I/O, so a
 * typo or missing flag fails fast instead of surfacing as a confusing
 * downstream error.
 */
export async function resolveProjectConfigPath(
  projectName: string | undefined,
  dir: string = ".",
): Promise<string> {
  const available = await listAvailableProjects(dir);
  const list = available.length > 0 ? available.join(", ") : "(none found)";
  if (!projectName) {
    throw new Error(`--project <name> is required. Available projects: ${list}`);
  }
  if (!available.includes(projectName)) {
    throw new Error(
      `Unknown project "${projectName}" (no pipeline.${projectName}.config.json in ${dir}). Available projects: ${list}`,
    );
  }
  return join(dir, `pipeline.${projectName}.config.json`);
}

/** Field paths (dot-notation) worth checking for leftover "___" placeholders. */
const PLACEHOLDER_PATHS: Array<[string, (c: Config) => unknown]> = [
  ["jira.triggerLabel", (c) => c.jira.triggerLabel],
  ["jira.handoffLabel", (c) => c.jira.handoffLabel],
  ["jira.repoLabel", (c) => c.jira.repoLabel],
  ["jira.mentionAccountId", (c) => c.jira.mentionAccountId],
  ["jira.claimStatus.from", (c) => c.jira.claimStatus.from],
  ["jira.claimStatus.to", (c) => c.jira.claimStatus.to],
  ["jira.pollJql.refine", (c) => c.jira.pollJql.refine],
  ["jira.pollJql.dev", (c) => c.jira.pollJql.dev],
  ["jira.statusNames.bounced", (c) => c.jira.statusNames.bounced],
  ["jira.statusNames.prOpen", (c) => c.jira.statusNames.prOpen],
  ["autoPromoteLabel", (c) => c.autoPromoteLabel],
  ["targetRepo.url", (c) => c.targetRepo.url],
  ["targetRepo.defaultBranch", (c) => c.targetRepo.defaultBranch],
  ["github.repo", (c) => c.github.repo],
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
