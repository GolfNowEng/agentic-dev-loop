// Cutover step: move the v1 state folders of both former repos under
// dev-loop's own root, where the v2 readers look (runs/v1/<role>/,
// .pipeline/v1/<role>/<slug>/). Dry run by default.
//   node scripts/migrate-v1-folders.mjs --dev-root <path> [--research-root <path>] [--v2-from <worktree>] [--write]
// --research-root is required unless --v2-from is given.
// --v2-from <worktree> (Ruling 40): also move <worktree>/runs/v2 and
// <worktree>/.pipeline/v2 to <dev-root>/runs/v2 and <dev-root>/.pipeline/v2,
// each only if it exists. Run it after the merge, before removing the v2
// worktree and before any loop starts from the dev root. Same refusals.
// Otherwise never touches runs/v2 or .pipeline/v2. Uses rename only (no copy fallback).
// Test seams: CUTOVER_PGREP overrides the pgrep executable;
// CUTOVER_FAKE_OTHER_DEVICE=<path> makes sources under that path report a
// different device id in the cross-volume pre-check.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function parse(argv) {
  const o = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") o.write = true;
    else if (a === "--dev-root" || a === "--research-root" || a === "--v2-from") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      o[{ "--dev-root": "dev", "--research-root": "research", "--v2-from": "v2From" }[a]] = resolve(v);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.dev || (!o.research && !o.v2From)) {
    throw new Error("usage: --dev-root <path> --research-root <path> [--v2-from <worktree>] [--write] (--research-root may be omitted only with --v2-from)");
  }
  return o;
}

// Returns matching pgrep lines (empty when none).
export function runningLoops(pgrep = process.env.CUTOVER_PGREP || "pgrep") {
  try {
    const out = execFileSync(pgrep, ["-fl", "src/main.ts"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.trim() && !l.includes("migrate-v1-folders"));
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}

function entries(dir, keep) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(keep).sort();
}

export function plan(devRoot, researchRoot, v2From) {
  const moves = [];
  if (v2From) {
    for (const rel of ["runs/v2", ".pipeline/v2"]) {
      const from = join(v2From, rel);
      if (existsSync(from) || isLink(from)) moves.push([from, join(devRoot, rel)]);
    }
  }
  const jsonl = (n) => n.endsWith(".jsonl");
  // lstat: a dangling symlink must not crash the run; links move as links.
  const kind = (p) => lstatSync(p);
  const slug = (root) => (n) => {
    if (["v1", "v2"].includes(n)) return false;
    const st = kind(join(root, ".pipeline", n));
    return st.isDirectory() || st.isSymbolicLink();
  };
  // Without --research-root (a --v2-from-only run, after the v1 migrate): no v1 moves.
  const v1Roots = researchRoot ? [[devRoot, "dev"], [researchRoot, "research"]] : [];
  for (const [root, role] of v1Roots) {
    for (const n of entries(join(root, "runs"), (n) => jsonl(n) && (kind(join(root, "runs", n)).isFile() || kind(join(root, "runs", n)).isSymbolicLink())))
      moves.push([join(root, "runs", n), join(devRoot, "runs", "v1", role, n)]);
    for (const n of entries(join(root, ".pipeline"), slug(root)))
      moves.push([join(root, ".pipeline", n), join(devRoot, ".pipeline", "v1", role, n)]);
  }
  return moves.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function deviceOf(p) {
  const fake = process.env.CUTOVER_FAKE_OTHER_DEVICE;
  const dev = lstatSync(p).dev;
  return fake && (p === fake || p.startsWith(fake + "/")) ? dev + 1 : dev;
}

function nearestExisting(p) {
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

function main() {
  const o = parse(process.argv.slice(2));
  if (o.research && realpathSync(o.dev) === realpathSync(o.research)) {
    console.error("Refusing: --dev-root and --research-root are the same directory");
    process.exit(1);
  }
  if (o.v2From && realpathSync(o.dev) === realpathSync(o.v2From)) {
    console.error("Refusing: --dev-root and --v2-from are the same directory");
    process.exit(1);
  }
  const moves = plan(o.dev, o.research, o.v2From);
  for (const [from, to] of moves) console.log(`move ${from} -> ${to}`);
  const loops = runningLoops();
  if (!o.write) {
    if (loops.length > 0)
      console.log(`WARNING: a loop process (src/main.ts) is running; --write will refuse until it stops:\n${loops.join("\n")}`);
    return;
  }
  if (loops.length > 0) {
    console.error(`Refusing: a loop process (src/main.ts) is running:\n${loops.join("\n")}`);
    process.exit(1);
  }
  const clash = moves.filter(([, to]) => existsSync(to));
  if (clash.length > 0) {
    for (const [, to] of clash) console.error(`Refusing: destination exists: ${to}`);
    process.exit(1);
  }
  const cross = moves.filter(([from, to]) => deviceOf(from) !== lstatSync(nearestExisting(dirname(to))).dev);
  if (cross.length > 0) {
    for (const [from, to] of cross) console.error(`Refusing: ${from} is on a different filesystem than ${to}; rename cannot cross volumes`);
    process.exit(1);
  }
  for (const [from, to] of moves) {
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch (e) {
      if (e.code === "EXDEV") {
        console.error(`Refusing: ${from} and ${to} are on different filesystems (EXDEV); no copy fallback. Moved so far stays moved.`);
        process.exit(1);
      }
      throw e;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrate-v1-folders.mjs")) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
