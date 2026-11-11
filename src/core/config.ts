// Loads and validates pipeline.config.json.
//
// This is a thin, pure-ish loader: read the file, parse it, hand back a
// typed Config. It does not resolve "___" placeholders -- callers that need
// a fully-bound config (e.g. RealJiraClient) are responsible for checking
// for placeholder values themselves and failing loudly if any remain.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodeReviewFieldsConfig, Config, LoopConfig } from "./types.ts";

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

/**
 * The directory to grant the spawned `claude -p` session access to via
 * `--add-dir`, beyond dev-loop's own cwd. When `targetRepo.path` is set,
 * ticket-to-pr's per-run worktrees are created inside that checkout (see
 * docs/logging.md), which sits outside dev-loop's own directory tree --
 * without an explicit grant, every Edit/Write into the worktree is denied
 * regardless of `--permission-mode acceptEdits` (that flag only
 * auto-answers the permission *prompt* for Edit/Write, it doesn't grant
 * directory access). Returns null when `targetRepo.path` is unset, since
 * the clone-based flow's worktrees live under `.pipeline/<slug>/repo`,
 * already inside dev-loop's own cwd.
 */
export function targetRepoAddDir(config: Config): string | null {
  return config.targetRepo.path ?? null;
}

/** Which role's required keys to check. */
export type ConfigRole = "research" | "dev";

/** Field paths (dot-notation) worth checking for leftover "___" placeholders. */
const PLACEHOLDER_PATHS: Array<[string, (c: Config) => unknown]> = [
  ["jira.triggerLabel", (c) => c.jira.triggerLabel],
  ["jira.handoffLabel", (c) => c.jira.handoffLabel],
  ["jira.repoLabel", (c) => c.jira.repoLabel],
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

/** Dev-role-only paths: checked for "___" whenever present, required when role is "dev". */
const CODE_REVIEW_FIELD_PATHS: Array<[string, keyof CodeReviewFieldsConfig]> = [
  ["jira.codeReviewFields.piiField", "piiField"],
  ["jira.codeReviewFields.piiNoImpactOptionId", "piiNoImpactOptionId"],
  ["jira.codeReviewFields.qaNotesField", "qaNotesField"],
];

/**
 * List which known config fields still hold the literal placeholder value
 * "___" (Appendix A of the pipeline spec not yet filled in). Empty array
 * means the config is fully bound. `jira.codeReviewFields` is dev-only: it
 * is checked whenever present, and with `role: "dev"` a missing block (or a
 * missing sub-field) is listed too, since the dev role cannot transition a
 * landed PR to Code Review without it.
 */
export function findPlaceholders(config: Config, role: ConfigRole = "research"): string[] {
  const missing = PLACEHOLDER_PATHS.filter(([, get]) => get(config) === "___").map(
    ([path]) => path,
  );
  const crf = config.jira.codeReviewFields;
  for (const [path, key] of CODE_REVIEW_FIELD_PATHS) {
    const value = crf?.[key];
    if (value === "___" || (role === "dev" && value === undefined)) missing.push(path);
  }
  return missing;
}

/**
 * Throws a clear error naming every field still set to "___" (or, for
 * `role: "dev"`, missing a required dev-only key), if any.
 */
export function assertNoPlaceholders(config: Config, role: ConfigRole = "research"): void {
  const missing = findPlaceholders(config, role);
  if (missing.length > 0) {
    throw new Error(
      `pipeline.config.json still has placeholder "___" (or missing) values for: ${missing.join(", ")}. ` +
        `Fill in Appendix A of the pipeline spec before using RealJiraClient.`,
    );
  }
}

/**
 * The dev role's Code Review field IDs. Throws if absent -- unreachable
 * after `assertNoPlaceholders(config, "dev")` at startup, so this only
 * narrows the optional type.
 */
export function requireCodeReviewFields(config: Config): CodeReviewFieldsConfig {
  const crf = config.jira.codeReviewFields;
  if (!crf) {
    throw new Error("pipeline.config.json is missing jira.codeReviewFields (required by the dev role).");
  }
  return crf;
}
