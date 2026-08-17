// Does this head sidecar still belong to this index?
//
//   npx tsx scripts/check-head.mjs data/en-wiki.index web/dist/en-wiki.head
//
// The head is the exact prefix of what a best-first walk over the index emits,
// and the site serves it *as* the first page of a search — same answers, same
// order, same scores. That is only true while the two files match. Rebuild the
// index and keep the old head, and the site will serve entries the index no
// longer contains, at scores it no longer has, with nothing to say anything is
// wrong: the head path never touches the index, so it cannot notice.
//
// That is not hypothetical. The English index is being rebuilt to drop
// Wikipedia's project pages, which removes phrases like "wikipedia wikiproject
// spam linkreports" — and those are near the *top* of the current head, since
// being formulaic is what got them there. A deploy that swapped the index and
// left the head would keep answering with them.
//
// So: sample the head, ask the index what each entry is worth (a single path
// down the trie, src/index-probe.ts), and require the two to agree. Sampled
// rather than exhaustive because the point is to catch a mismatched *pair*,
// which shows up in the first handful of entries; a head that disagrees about
// one entry in five hundred thousand is a different bug.

import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { parseHeadIndex } from "../src/head-index.js";
import { probeCount } from "../src/index-probe.js";

const [indexPath, headPath] = process.argv.slice(2);
if (!indexPath || !headPath) {
  console.error("usage: check-head.mjs <index> <head>");
  process.exit(2);
}

const SAMPLE = Number(process.env.SAMPLE ?? 600);
/**
 * Scores are stored to five significant digits, so they are compared
 * relatively rather than exactly — see the note in src/head-index.ts.
 */
const TOLERANCE = 1e-4;

const reader = await IndexReader.open(
  new MemorySource(fs.readFileSync(indexPath)),
);
const head = parseHeadIndex(fs.readFileSync(headPath, "utf8"));
if (head.text.length === 0) {
  console.error(`${headPath}: empty`);
  process.exit(1);
}

/**
 * Which entries to check: the top of the head, the bottom, and a spread in
 * between. The top matters most — those are the entries a reader sees first,
 * and the ones a stale head gets most confidently wrong.
 */
function positions(n) {
  const out = new Set();
  const edge = Math.min(100, n);
  for (let i = 0; i < edge; ++i) out.add(i);
  for (let i = Math.max(0, n - edge); i < n; ++i) out.add(i);
  const step = Math.max(1, Math.floor(n / Math.max(1, SAMPLE - out.size)));
  for (let i = 0; i < n; i += step) out.add(i);
  return [...out].sort((a, b) => a - b);
}

const checked = positions(head.text.length);
const missing = [];
const wrong = [];
for (const i of checked) {
  const text = head.text[i];
  const count = await probeCount(reader, text);
  if (count === 0) {
    missing.push({ at: i, text });
    continue;
  }
  if (Math.abs(count - head.score[i]) / count > TOLERANCE) {
    wrong.push({ at: i, text, head: head.score[i], index: count });
  }
}

// The head must also still be in descending score order, which is what makes
// serving a prefix of it the same as serving the first page of a search.
let disordered = 0;
for (let i = 1; i < head.score.length; ++i) {
  if (head.score[i] > head.score[i - 1]) ++disordered;
}

const name = headPath.split("/").pop();
if (missing.length === 0 && wrong.length === 0 && disordered === 0) {
  console.error(
    `${name} OK: ${checked.length} of ${head.text.length} entries checked, ` +
      `all present with matching scores`,
  );
  process.exit(0);
}

for (const m of missing.slice(0, 8)) {
  console.error(`  missing from the index: [${m.at}] ${JSON.stringify(m.text)}`);
}
for (const w of wrong.slice(0, 8)) {
  console.error(
    `  score disagrees: [${w.at}] ${JSON.stringify(w.text)} ` +
      `head ${w.head.toExponential(4)} vs index ${w.index.toExponential(4)}`,
  );
}
if (disordered > 0) {
  console.error(`  ${disordered} entries are out of descending score order`);
}
console.error(
  `${name} STALE: ${missing.length} missing, ${wrong.length} mis-scored ` +
    `of ${checked.length} checked — rebuild it from this index ` +
    `(npm run build-head)`,
);
process.exit(1);
