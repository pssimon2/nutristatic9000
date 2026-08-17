// Get a freshly built index ready to serve, and refuse to ship it if it isn't.
//
//   npx tsx scripts/prepare-index.mjs data/enwiki-ns0.index en-wiki-ns0
//
// An index does not go out alone. It needs a `.idxz` compressed sidecar, or
// range mode fetches the raw file; and a `.head`, or every query that sifts
// finished matches falls back to a walk over the network. The head in
// particular has to be rebuilt *from this index* — see check-head.mjs for what
// a stale one does, which is to keep answering with entries the index no longer
// contains and never notice.
//
// So this is the whole set, built in one place and checked before anything
// leaves the machine: three files and a verdict.
//
// It deliberately does not upload. The indexes are served from the site root and
// shared between deployments, so replacing one changes every page that points at
// it — that is a decision to take deliberately, with the files already verified
// and a name chosen, not a step buried in a build script.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const [indexPath, name] = process.argv.slice(2);
if (!indexPath || !name) {
  console.error("usage: prepare-index.mjs <index> <served-name>");
  console.error("  e.g. prepare-index.mjs data/enwiki-ns0.index en-wiki-ns0");
  process.exit(2);
}
if (!fs.existsSync(indexPath)) {
  console.error(`${indexPath}: no such file`);
  process.exit(1);
}

const OUT = process.env.OUT_DIR ?? "dist-index";
fs.mkdirSync(OUT, { recursive: true });
const served = path.join(OUT, `${name}.index`);
const sidecar = `${served}.idxz`;
const head = path.join(OUT, `${name}.head`);

/** Run a step, and stop the whole thing if it fails. */
function step(what, argv) {
  process.stderr.write(`\n== ${what}\n`);
  const r = spawnSync("npx", argv, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${what}: failed (exit ${r.status})`);
    process.exit(1);
  }
}

// A copy rather than a move: the build output stays where it is, so a failed
// verification does not leave the only copy half-renamed.
process.stderr.write(`== copying ${indexPath} -> ${served}\n`);
fs.copyFileSync(indexPath, served);

// compress-index writes <input>.idxz itself, which is exactly `sidecar`.
step("compressed sidecar", ["tsx", "cli/compress-index.ts", served]);
step("head sidecar", [
  "tsx",
  "scripts/build-head.mjs",
  served,
  "--out",
  head,
]);
// The check that matters: the head must describe *this* index.
step("head matches index", [
  "tsx",
  "scripts/check-head.mjs",
  served,
  head,
]);

const mb = (p) => `${(fs.statSync(p).size / 1e6).toFixed(0)} MB`;
process.stderr.write(
  `\nready in ${OUT}/\n` +
    `  ${name}.index       ${mb(served)}   -> the site root\n` +
    `  ${name}.index.idxz  ${mb(sidecar)}   -> the site root, beside it\n` +
    `  ${name}.head        ${mb(head)}   -> the page's own directory\n` +
    `\nNothing has been uploaded. The indexes are shared between deployments,\n` +
    `so putting one in place changes every page that points at it.\n`,
);
