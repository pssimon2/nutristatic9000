// Enforce the layering, and forbid import cycles.
//
//   node scripts/check-layers.mjs
//
// Two rules, both of which were violated or nearly so when this was written:
//
//   * The engine may not import the apps. `src/` is the engine and its data;
//     `web/` and `cli/` are front ends. An import the other way makes the
//     engine unusable outside a browser, and is the first step to the CLI and
//     the site behaving differently — which they already did, more than once.
//
//   * No cycles. `find-expr.ts` and `expr-parse.ts` imported each other for
//     the sake of one error class. ESM hoisting forgives that right up until
//     someone reorders a declaration or a bundler splits the modules
//     differently, and then it fails as an undefined class at run time.
//
// A script rather than a dependency: the repository has six devDependencies
// and this is sixty lines. A finer engine/data/io split
// needs the files moved first; these two rules are the part that can be
// enforced today, and they are the ones that catch real drift.

import * as fs from "node:fs";
import * as path from "node:path";

/** Which layer a file belongs to, by its top-level directory. */
const LAYER = { src: "engine", web: "app", cli: "app", test: "test" };

/** layer -> layers it may import. */
const ALLOWED = {
  engine: ["engine"],
  app: ["engine", "app"],
  test: ["engine", "app", "test"],
};

const ROOTS = ["src", "web", "cli", "test"];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const files = ROOTS.filter((r) => fs.existsSync(r)).flatMap(walk);
const known = new Set(files);
const layerOf = (f) => LAYER[f.split(path.sep)[0]];

const graph = new Map();
const problems = [];

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const deps = [];
  for (const spec of specifiers) {
    if (!spec.startsWith(".")) continue; // a package, not our code
    const resolved = path.normalize(
      path.join(path.dirname(file), spec.replace(/\.js$/, ".ts")),
    );
    if (!known.has(resolved)) continue; // an asset (?url, .wasm) or a type-only path
    deps.push(resolved);
    const from = layerOf(file);
    const to = layerOf(resolved);
    if (!ALLOWED[from].includes(to)) {
      problems.push(`${file} (${from}) imports ${resolved} (${to})`);
    }
  }
  graph.set(file, deps);
}

// Cycles, reported once each with the whole loop shown.
const state = new Map();
const cycles = [];
function visit(node, stack) {
  const at = stack.indexOf(node);
  if (at !== -1) {
    cycles.push([...stack.slice(at), node]);
    return;
  }
  if (state.get(node)) return;
  state.set(node, true);
  for (const dep of graph.get(node) ?? []) visit(dep, [...stack, node]);
}
for (const file of files) visit(file, []);

for (const cycle of cycles) problems.push(`import cycle: ${cycle.join(" -> ")}`);

if (problems.length > 0) {
  console.error("layering violations:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\n${problems.length} problem(s). The engine (src/) must not import the ` +
      `apps (web/, cli/), and nothing may form an import cycle.`,
  );
  process.exit(1);
}

console.error(`layers OK: ${files.length} files, no cycles`);
