// Build the head of an index: its highest-scoring entries, as a sidecar.
//
//   npx tsx scripts/build-head.mjs data/en-wiki.index --out web/public/en-wiki.head
//
// The file is the exact prefix of what a best-first search over `.*` emits, so
// searching it gives the same answers in the same order the index would —
// which is what lets the worker serve it as the first page of a real search
// rather than as a guess. See src/head-index.ts for why.
//
// Half a million entries is 12 MB of text and 3.7 MB over the wire, and covers
// every query on the recipes page that a streamed search could not answer.
// A million costs 6 MB compressed and answers no more of them.

import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";
import {
  COMPOUND_PIECE_FLOOR,
  REVERSAL_FLOOR,
} from "../src/index-words.js";

const args = process.argv.slice(2);
const input = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
if (!input) {
  console.error("usage: build-head.mjs <index> [--out f] [--count n]");
  process.exit(2);
}
const out = opt("out", input.replace(/\.index$/, "") + ".head");
const count = Number(opt("count", "500000"));

const data = fs.readFileSync(input);
const reader = await IndexReader.open(new MemorySource(data));
const session = new SearchSession(reader, ".*", new SessionContext());

const lines = [];
const started = Date.now();
// `.*` matches everything the index holds, so best-first over it *is* the
// index in score order — no separate ranking pass, and no risk of ordering it
// differently from the search this stands in for.
await session.run(2e7, count, (r) => {
  lines.push(`${r.text}\t${r.score.toExponential(4)}`);
});

fs.writeFileSync(out, lines.join("\n") + "\n");
const mb = (fs.statSync(out).size / 1e6).toFixed(1);
console.error(
  `wrote ${lines.length} entries to ${out} (${mb} MB, ` +
    `${session.steps} steps, ${((Date.now() - started) / 1000).toFixed(0)}s)`,
);
// The head is also the word oracle behind `{compound …}` and `{reversible …}`
// (see headWordChecker), and that only holds while the head reaches *below*
// the frequency floors those constructs use: if it does, absence from the head
// proves a word fails the floor, and neither construct has to touch the index.
// Below is where the head stops holding entries; the floors are shares of the
// corpus in the same units.
const lowest = Number(lines[lines.length - 1].split("\t")[1]);
const floors = [
  ["compound", COMPOUND_PIECE_FLOOR * reader.count()],
  ["reversible", REVERSAL_FLOOR * reader.count()],
];
for (const [name, floor] of floors) {
  const margin = (floor / lowest).toFixed(1);
  if (lowest <= floor) {
    console.error(`  {${name}} floor ${floor.toExponential(2)}: covered ${margin}x over`);
  } else {
    console.error(
      `WARNING: this head stops at ${lowest.toExponential(2)}, above the ` +
        `{${name}} floor of ${floor.toExponential(2)} — that construct will ` +
        `fall back to index lookups, which over a streamed index is slow. ` +
        `Build with a larger --count.`,
    );
  }
}

if (lines.length < count) {
  console.error(
    `note: the index held only ${lines.length} entries, fewer than the ${count} asked for`,
  );
}
