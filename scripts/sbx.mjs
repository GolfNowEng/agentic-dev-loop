// Helpers for the sbx sandbox adapter, so the sbx commands don't have to be
// remembered. See docs/sandbox-sbx.md.
//
//   npm run sbx:status                       sandboxes, secrets, policies, pending approvals, templates
//   npm run sbx:dashboard                    sbx's live TUI (watch the loop's sandboxes come and go)
//   npm run sbx:cleanup [-- --project=webtarsthree]   remove this project's leftover dl-* sandboxes
//   npm run sbx:smoke   [-- --project=webtarsthree]   one sandbox built from the loop's create args,
//                                            one tiny `claude -p` inside it, plus one read-only Jira
//                                            call when sandbox.sbx.mcp lists atlassian, then removed (a few cents)
//   npm run sbx:template -- --tag=v3         explain the template rebuild
//   npm run sbx:template:build -- --tag=v3 [--node=26]   rebuild it: build sandbox, sandbox/sbx/template.sh,
//                                            save, remove (packages live in that script)
//
// Access grants stay with the human: this script never runs `sbx policy allow`,
// `sbx secret set` or `sbx policy approval respond`. It only prints them.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { FlagError, parseFlags } from "../src/core/flags.ts";
import { fillModelEnvFromClaudeSettings } from "../src/core/claude-settings-env.ts";
import { repoSlugFromUrl } from "../src/core/config.ts";
import { allowHintLines, createArgs, rootEnvFiles } from "../src/sandbox/sbx/adapter.ts";
import { validateSbxConfig } from "../src/sandbox/sbx/config.ts";
import { sbxAdapter } from "../src/sandbox/sbx/index.ts";
import { sandboxInstancePrefix } from "../src/worker/skill-runner.ts";

const ROOT = resolve(import.meta.dirname, "..");
const [cmd, ...rest] = process.argv.slice(2);

let flags;
try {
  flags = parseFlags(rest, { values: ["--project", "--tag", "--node"], bools: [] }, `sbx ${cmd}`);
} catch (err) {
  if (!(err instanceof FlagError)) throw err;
  console.error(err.message);
  process.exit(1);
}
const project = flags.values["--project"] ?? "webtarsthree";
if (!/^[a-z0-9-]+$/.test(project)) {
  console.error(`--project=${JSON.stringify(project)} must match /^[a-z0-9-]+$/`);
  process.exit(1);
}

/** Runs sbx with inherited stdio (never a shell). Returns its exit code. */
function sbx(args, { quiet = false } = {}) {
  if (!quiet) console.log(`\n$ sbx ${args.join(" ")}`);
  const r = spawnSync("sbx", args, { stdio: "inherit" });
  if (r.error) {
    console.error(`sbx not runnable: ${r.error.message}`);
    process.exit(1);
  }
  return r.status ?? 1;
}

function captured(args) {
  return spawnSync("sbx", args, { encoding: "utf8" });
}

function projectConfig() {
  const raw = JSON.parse(readFileSync(resolve(ROOT, `pipeline.${project}.config.json`), "utf8"));
  const slug = repoSlugFromUrl(raw.targetRepo.url);
  if (!raw.sandbox?.sbx) {
    console.error(`pipeline.${project}.config.json has no sandbox.sbx block (see docs/sandbox-sbx.md)`);
    process.exit(1);
  }
  return { slug, cfg: validateSbxConfig(raw.sandbox.sbx), repoPath: raw.targetRepo.path };
}

/**
 * Asks the person at the terminal to type "allow". No terminal (an agent, a pipe): never allowed.
 * Ctrl-D or Ctrl-C at the prompt counts as "no", so the caller's cleanup still runs.
 */
async function confirmAllow(dir) {
  if (!process.stdin.isTTY) {
    console.log(`\n${dir}/.envrc: not allowing it (no terminal to ask). Rerun from your own terminal to approve it.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((done) => {
      rl.on("close", () => done(""));
      rl.on("SIGINT", () => rl.close());
      rl.question(`\nAllow ${dir}/.envrc inside the template? Review it first. Type "allow" to approve: `).then(done, () => done(""));
    });
    return answer.trim() === "allow";
  } finally {
    rl.close();
  }
}

/** The same rule preflight applies: no env file at the top of dev-loop's folder, which every sandbox mounts. */
function refuseRootEnvFiles() {
  const found = rootEnvFiles(ROOT);
  if (found.length > 0) {
    console.error(`${found[0]} is in ${ROOT}, which the sandbox can read: move it out of the repo and point DEVLOOP_ENV_FILE at it (see docs/sandbox-sbx.md)`);
    process.exit(1);
  }
}

/** True when dev-loop-sbx:<tag> exists. Exits (fails closed) when sbx's answer can't be read. */
function templateTagExists(tag) {
  const r = captured(["template", "ls", "--json"]);
  let list;
  try {
    if (r.error || r.status !== 0) throw new Error(r.error?.message ?? (r.stderr || "").trim());
    list = JSON.parse(r.stdout);
    if (!Array.isArray(list)) throw new Error("not a list");
  } catch (err) {
    console.error(`Could not read sbx template ls --json (${err.message}); not building, so no existing tag is overwritten.`);
    process.exit(1);
  }
  return list.some((t) => typeof t?.repository === "string" && /(^|\/)dev-loop-sbx$/.test(t.repository) && t.tag === tag);
}

function templateTag() {
  const tag = flags.values["--tag"];
  if (!tag || !/^[A-Za-z0-9._-]+$/.test(tag)) {
    console.error("--tag=<tag> is required, e.g. --tag=v3");
    process.exit(1);
  }
  return tag;
}

function dlSandboxes(prefix) {
  const r = captured(["ls", "--json"]);
  if (r.status !== 0) {
    console.error(`sbx ls failed: ${r.stderr.trim()}`);
    process.exit(1);
  }
  const list = JSON.parse(r.stdout || "[]");
  return list.map((s) => s?.name).filter((n) => typeof n === "string" && n.startsWith(prefix));
}

switch (cmd) {
  case "status": {
    sbx(["ls"]);
    sbx(["secret", "ls"]);
    sbx(["policy", "ls"]);
    sbx(["policy", "approval", "ls"]);
    sbx(["template", "ls"]);
    console.log("\nTo inspect a pending approval: sbx policy approval inspect <id>  (answering it is yours to do)");
    break;
  }

  case "dashboard": {
    process.exit(sbx(["tui"], { quiet: true }));
  }

  case "cleanup": {
    const { slug } = projectConfig();
    const prefix = sandboxInstancePrefix(slug);
    const names = dlSandboxes(prefix);
    if (names.length === 0) console.log(`No ${prefix}* sandboxes.`);
    for (const n of names) sbx(["rm", "-f", n]);
    break;
  }

  case "smoke": {
    const { slug, cfg } = projectConfig();
    refuseRootEnvFiles();
    fillModelEnvFromClaudeSettings(process.env);
    const name = `${sandboxInstancePrefix(slug)}smoke-${randomBytes(3).toString("hex")}`;
    // The same argv the loop's prepare uses, so the smoke test proves the real path.
    const create = createArgs(name, cfg, [ROOT]);
    console.log(`Smoke test in ${name}. Watch it in another terminal: npm run sbx:dashboard`);
    let code = 1;
    try {
      if (sbx(create) !== 0) throw new Error("sbx create failed");
      const envArgs = cfg.envAllow.filter((n) => process.env[n]).flatMap((n) => ["-e", n]);
      code = sbx(["exec", "-w", ROOT, ...envArgs, name, "claude", "-p", "--model", "haiku", "Reply with exactly: sandbox ok"]);
      // The loop's allowlist uses the adapter's Atlassian tool names; prove one is callable by that name.
      const mcp = code === 0 ? sbxAdapter.atlassianMcp?.(cfg) : undefined;
      if (mcp) {
        const tool = `mcp__${mcp.server}__getAccessibleAtlassianResources`;
        console.log(`\nJira check: calling ${tool} (read-only)...`);
        const ask = `Call the tool ${tool} once. If it returns at least one Atlassian site, reply with exactly: jira ok. Otherwise reply with exactly: jira failed, then one line saying why.`;
        const r = spawnSync("sbx", ["exec", "-w", ROOT, ...envArgs, name, "claude", "-p", "--model", "haiku", `--allowedTools=${tool}`, ask], { encoding: "utf8" });
        const out = (r.stdout ?? "").trim();
        console.log(out || (r.stderr ?? "").trim());
        if (r.status !== 0 || !/^jira ok\b/m.test(out)) {
          code = r.status || 1;
          console.log(`Jira check failed: the sandbox could not call ${tool}. Check: sbx mcp ls (atlassian must be ready), then docs/sandbox-sbx.md section 9.`);
        }
      }
      console.log(code === 0 ? "\nSmoke test passed." : `\nSmoke test failed (exit ${code}). Check: npm run sbx:status`);
    } catch (err) {
      console.error(String(err.message ?? err));
    } finally {
      sbx(["rm", "-f", name]);
      const lines = allowHintLines(captured(["policy", "log", name, "--json"]).stdout ?? "");
      if (lines === undefined) console.log(`\nCould not read the policy log; check: sbx policy log ${name}`);
      else if (lines.length > 0) console.log(`\nBlocked during the smoke test (review, then allow yourself if you approve):\n${lines.map((l) => `  ${l}`).join("\n")}`);
    }
    process.exit(code);
  }

  case "template": {
    // Prints the manual steps; template:build runs them.
    const tag = templateTag();
    const { repoPath } = projectConfig();
    console.log(`Rebuild the template as dev-loop-sbx:${tag}. One command does it all:

  npm run sbx:template:build -- --tag=${tag}

It creates a build sandbox from the kit (with dev-loop and ${repoPath ?? "the target repo"} mounted),
runs sandbox/sbx/template.sh inside it (node, jq, direnv, git settings), asks you to
type "allow" for the target repo's .envrc,
saves the template, and removes the build sandbox. Edit that file to add packages.
Then set "template": "docker.io/library/dev-loop-sbx:${tag}" and run npm run sbx:preflight.`);
    break;
  }

  case "template:build": {
    const tag = templateTag();
    const { cfg, repoPath } = projectConfig();
    const nodeMajor = (flags.values["--node"] ?? process.versions.node.split(".")[0]).trim();
    if (!/^[0-9]+$/.test(nodeMajor)) {
      console.error("--node must be a major version like 26");
      process.exit(1);
    }
    const ref = `dev-loop-sbx:${tag}`;
    refuseRootEnvFiles();
    if (templateTagExists(tag)) {
      console.error(`${ref} already exists. Pick a new --tag (keep the old one for rollback).`);
      process.exit(1);
    }
    const mounts = [ROOT, ...(repoPath && repoPath !== ROOT ? [repoPath] : [])];
    const name = "dl-template-build";
    console.log(`Building ${ref} (node ${nodeMajor}). This takes a few minutes.`);
    let ok = false;
    try {
      sbx(["rm", "-f", name], { quiet: true });
      if (sbx(["create", "--name", name, "--no-progress", "--no-input", "claude", "--kit", cfg.kitDir, ...mounts]) !== 0) throw new Error("sbx create failed");
      const script = resolve(ROOT, "sandbox/sbx/template.sh");
      if (sbx(["exec", name, "sh", script, nodeMajor]) !== 0) {
        throw new Error("template.sh failed. If a host was blocked, review npm run sbx:status and allow it yourself, then rerun.");
      }
      // direnv allow is an approval, like a network grant: only a person at a terminal can give it.
      for (const dir of mounts.slice(1).filter((d) => existsSync(join(d, ".envrc")))) {
        if (!(await confirmAllow(dir))) {
          console.log(`Skipped. Runs will stop with "the target repo's .envrc is not allowed" until you allow it in a rebuild.`);
          continue;
        }
        if (sbx(["exec", "-w", dir, name, "direnv", "allow"]) !== 0 || sbx(["exec", "-w", dir, name, "direnv", "exec", dir, "true"]) !== 0) {
          throw new Error(`direnv allow failed for ${dir}/.envrc`);
        }
      }
      if (sbx(["stop", name]) !== 0) throw new Error("sbx stop failed");
      if (sbx(["template", "save", name, ref]) !== 0) throw new Error("sbx template save failed");
      ok = true;
    } catch (err) {
      console.error(`\n${err.message ?? err}`);
    } finally {
      sbx(["rm", "-f", name], { quiet: true });
    }
    if (!ok) process.exit(1);
    console.log(`\nSaved docker.io/library/${ref}. Next:
  1. set "template": "docker.io/library/${ref}" in pipeline.${project}.config.json (sandbox.sbx)
  2. npm run sbx:preflight && npm run sbx:smoke`);
    break;
  }

  default:
    console.error("usage: node scripts/sbx.mjs status|dashboard|cleanup|smoke|template|template:build [--project=<name>] [--tag=<tag>] [--node=<major>]");
    process.exit(1);
}
