// The one module that knows every on-disk path the pipeline uses. Every
// segment is validated against the Global Constraints identifier regexes and
// every result is checked to stay inside the directory it belongs to, so a
// hostile ticket key / session id / slug can never escape (UnsafePathError).

import { isAbsolute, join, resolve, sep } from "node:path";
import type { Role } from "./types.ts";

/** A Jira issue key, e.g. "TARS-1465". */
export const TICKET_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
/** A session id, e.g. "s1". */
export const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A project slug. */
export const PROJECT_SLUG = /^[a-z0-9-]+$/;
/** The format runIdNow() produces. */
export const RUN_ID = /^\d{8}T\d{6}Z$/;
/** v1 slugs come from repoSlugFromUrl (any repo name): a single safe segment. */
const LEGACY_SLUG = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ROLES: readonly string[] = ["research", "dev"];

function check(label: string, value: string, re: RegExp): string {
  if (typeof value !== "string" || !re.test(value)) {
    throw new UnsafePathError(`${label} ${JSON.stringify(value)} must match ${re}`);
  }
  return value;
}

function checkRole(role: string): Role {
  if (!ROLES.includes(role)) throw new UnsafePathError(`role ${JSON.stringify(role)} must be one of ${ROLES.join(", ")}`);
  return role as Role;
}

function contain(rel: string, base: string, roots: string[]): string {
  const abs = resolve(base, rel);
  if (!roots.some((r) => abs.startsWith(resolve(base, r) + sep))) {
    throw new UnsafePathError(`path ${JSON.stringify(rel)} escapes ${roots.join(" and ")}`);
  }
  return rel;
}

const V2 = ["runs/v2", ".pipeline/v2"];

/** runs/v2/<project>.jsonl */
export function v2RunsLog(project: string): string {
  check("project", project, PROJECT_SLUG);
  return contain(`runs/v2/${project}.jsonl`, REPO_ROOT, V2);
}

/** runs/v1/<role>/<project>.jsonl (post-cutover v1 archive layout). */
export function v1RunsLog(role: Role, project: string): string {
  checkRole(role);
  check("project", project, PROJECT_SLUG);
  return contain(`runs/v1/${role}/${project}.jsonl`, REPO_ROOT, ["runs/v1"]);
}

/** .pipeline/v2/<project>/<session>/<ticket>/<phase>-<runId> (usage.json lives inside). */
export function v2RunDir(project: string, session: string, ticket: string, phase: Role, runId: string): string {
  check("project", project, PROJECT_SLUG);
  check("session", session, SESSION_ID);
  check("ticket", ticket, TICKET_KEY);
  checkRole(phase);
  check("runId", runId, RUN_ID);
  return contain(`.pipeline/v2/${project}/${session}/${ticket}/${phase}-${runId}`, REPO_ROOT, V2);
}

/** .pipeline/v2/<project>/repo */
export function v2CloneDir(project: string): string {
  check("project", project, PROJECT_SLUG);
  return contain(`.pipeline/v2/${project}/repo`, REPO_ROOT, V2);
}

/** .pipeline/v2/<project>/sessions */
export function v2SessionsDir(project: string): string {
  check("project", project, PROJECT_SLUG);
  return contain(`.pipeline/v2/${project}/sessions`, REPO_ROOT, V2);
}

/** "YYYYMMDDTHHMMSSZ" (UTC). */
export function runIdNow(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/** Resolve a repo-relative path from the functions above to an absolute one, re-checking containment. */
export function resolveRepoPath(rel: string): string {
  if (isAbsolute(rel)) throw new UnsafePathError(`path ${JSON.stringify(rel)} must be repo-relative`);
  contain(rel, REPO_ROOT, [...V2, "runs/v1"]);
  return resolve(REPO_ROOT, rel);
}

// ---- v1 --phase runner paths: RELATIVE, resolved against process.cwd() ----

function legacy(rel: string): string {
  return contain(rel, process.cwd(), ["runs", ".pipeline"]);
}

/**
 * runs/<slug>.jsonl, relative to cwd.
 * @deprecated — removed with the v1 runners (Task 13/14)
 */
export function legacyRunsLog(slug: string): string {
  check("slug", slug, LEGACY_SLUG);
  return legacy(`runs/${slug}.jsonl`);
}

/**
 * runs/<slug>.reset-archive.jsonl, relative.
 * @deprecated — removed with the v1 runners (Task 13/14)
 */
export function legacyRunsArchive(slug: string): string {
  check("slug", slug, LEGACY_SLUG);
  return legacy(`runs/${slug}.reset-archive.jsonl`);
}

/**
 * The runs/ directory itself, relative.
 * @deprecated — removed with the v1 runners (Task 13/14)
 */
export function legacyRunsRoot(): string {
  return "runs";
}

/**
 * .pipeline/<slug>, relative to cwd.
 * @deprecated — removed with the v1 runners (Task 13/14)
 */
export function legacyPipelineDir(slug: string): string {
  check("slug", slug, LEGACY_SLUG);
  return legacy(`.pipeline/${slug}`);
}

/**
 * .pipeline/<slug>/runs, relative.
 * @deprecated — removed with the v1 runners (Task 13/14)
 */
export function legacyRunDirs(slug: string): string {
  return join(legacyPipelineDir(slug), "runs");
}

/**
 * .pipeline/<slug>/raw-usage, relative.
 * @deprecated — removed with the v1 runners (Task 13/14)
 */
export function legacyRawUsageDir(slug: string): string {
  return join(legacyPipelineDir(slug), "raw-usage");
}
