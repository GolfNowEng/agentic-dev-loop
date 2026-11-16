// Helpers for the sbx sandbox adapter, so the sbx commands don't have to be
// remembered. See docs/sandbox-sbx.md.
//
//   npm run sbx:status                       sandboxes, secrets, policies, pending approvals, templates
//   npm run sbx:dashboard                    sbx's live TUI (watch the loop's sandboxes come and go)
//   npm run sbx:cleanup [-- --project=webtarsthree]   remove this project's leftover dl-* sandboxes
//   npm run sbx:smoke   [-- --project=webtarsthree]   one sandbox built exactly as the loop builds it,
//                                            one tiny `claude -p` inside it, then removed (a few cents)
//   npm run sbx:template [-- --tag=v2]       print the steps to (re)build the template
//
// Access grants stay with the human: this script never runs `sbx policy allow`,
// `sbx secret set` or `sbx policy approval respond`. It only prints them.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FlagError, parseFlags } from "../src/core/flags.ts";
import { fillModelEnvFromClaudeSettings } from "../src/core/claude-settings-env.ts";
import { repoSlugFromUrl } from "../src/core/config.ts";
import { createArgs } from "../src/sandbox/sbx/adapter.ts";
import { validateSbxConfig } from "../src/sandbox/sbx/config.ts";
import { sandboxInstancePrefix } from "../src/worker/skill-runner.ts";

const ROOT = resolve(import.meta.dirname, "..");
const [cmd, ...rest] = process.argv.slice(2);

let flags;
try {
  flags = parseFlags(rest, { values: ["--project", "--tag"], bools: [] }, `sbx ${cmd}`);
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
      console.log(code === 0 ? "\nSmoke test passed." : `\nSmoke test failed (exit ${code}). Check: npm run sbx:status`);
    } catch (err) {
      console.error(String(err.message ?? err));
    } finally {
      sbx(["rm", "-f", name]);
      const blocked = captured(["policy", "log", name, "--json"]);
      try {
        const hosts = [...new Set((JSON.parse(blocked.stdout).blocked ?? []).map((b) => b.host))];
        if (hosts.length > 0) console.log(`\nBlocked during the smoke test (review, then allow yourself if you approve):\n${hosts.map((h) => `  sbx policy allow network ${h.replace(/:\d+$/, "")}`).join("\n")}`);
      } catch {
        /* no log: nothing to report */
      }
    }
    process.exit(code);
  }

  case "template": {
    const tag = flags.values["--tag"] ?? "v1";
    if (!/^[A-Za-z0-9._-]+$/.test(tag)) {
      console.error("--tag must be a plain tag like v2");
      process.exit(1);
    }
    console.log(`Rebuild the sandbox template as dev-loop-sbx:${tag} (run these yourself):

  sbx create --name dl-template-build claude --kit ~/Desktop/Repos/keystone-bedrock-kit ${ROOT}
  sbx exec -it dl-template-build bash
     # inside the sandbox (prompt changes):
     curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -    # setup_26.x for node 26
     sudo apt-get install -y nodejs jq
     git config --global url."https://github.com/".insteadOf git@github.com:
     git config --global core.pager cat
     node --version && jq --version && git --version && gh --version
     exit
  sbx template save dl-template-build dev-loop-sbx:${tag}
  sbx rm dl-template-build

Then set "template": "docker.io/library/dev-loop-sbx:${tag}" in the project's sandbox.sbx block,
and run: npm run sbx:preflight`);
    break;
  }

  default:
    console.error("usage: node scripts/sbx.mjs status|dashboard|cleanup|smoke|template [--project=<name>] [--tag=<tag>]");
    process.exit(1);
}
