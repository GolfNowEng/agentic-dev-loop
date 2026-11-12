// Cutover step: move the v1 state folders of both former repos under
// dev-loop's own root, where the v2 readers look (runs/v1/<role>/,
// .pipeline/v1/<role>/<slug>/). Dry run by default.
//   node scripts/migrate-v1-folders.mjs --dev-root <path> --research-root <path> [--write]
// Never touches runs/v2 or .pipeline/v2. Uses rename only (no copy fallback).
// Test seam: CUTOVER_PGREP overrides the pgrep executable.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function parse(argv) {
  const o = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") o.write = true;
    else if (a === "--dev-root" || a === "--research-root") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      o[a === "--dev-root" ? "dev" : "research"] = resolve(v);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.dev || !o.research) throw new Error("usage: --dev-root <path> --research-root <path> [--write]");
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

export function plan(devRoot, researchRoot) {
  const moves = [];
  const jsonl = (n) => n.endsWith(".jsonl");
  const slug = (root) => (n) => !["v1", "v2"].includes(n) && statSync(join(root, ".pipeline", n)).isDirectory();
  for (const [root, role] of [[devRoot, "dev"], [researchRoot, "research"]]) {
    for (const n of entries(join(root, "runs"), (n) => jsonl(n) && statSync(join(root, "runs", n)).isFile()))
      moves.push([join(root, "runs", n), join(devRoot, "runs", "v1", role, n)]);
    for (const n of entries(join(root, ".pipeline"), slug(root)))
      moves.push([join(root, ".pipeline", n), join(devRoot, ".pipeline", "v1", role, n)]);
  }
  return moves.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function main() {
  const o = parse(process.argv.slice(2));
  const moves = plan(o.dev, o.research);
  for (const [from, to] of moves) console.log(`move ${from} -> ${to}`);
  if (!o.write) return;

  const loops = runningLoops();
  if (loops.length > 0) {
    console.error(`Refusing: a loop process (src/main.ts) is running:\n${loops.join("\n")}`);
    process.exit(1);
  }
  const clash = moves.filter(([, to]) => existsSync(to));
  if (clash.length > 0) {
    for (const [, to] of clash) console.error(`Refusing: destination exists: ${to}`);
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
