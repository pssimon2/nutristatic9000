// Performance regression gate.
//
//   node scripts/bench.mjs            # run and compare against the baseline
//   node scripts/bench.mjs --update   # rewrite the baseline (deliberate changes)
//   node scripts/bench.mjs --json     # machine-readable, for anything else
//
// Runs against `web/public/demo.index`, which is committed — the previous
// benchmark read `data/simple-wiki.index` and so failed outright in a clean
// checkout, which is a poor foundation for a gate.
//
// **Step counts are the gate; time is advisory.** A step is one trie node
// expanded, and for a given index and query the count is exact and
// reproducible — so a change in it means the engine explores differently,
// which is precisely what a regression is. Wall-clock on a shared CI runner is
// not reproducible, and gating on it buys flaky builds rather than confidence.
// It is printed, because a 3x slowdown at identical step counts is worth
// seeing even if no machine can assert it.
//
// The grid is query *shapes*, because they stress different parts: a literal
// walks the trie, an anagram builds an enormous lazy product, a big list is a
// wide alternation, negation is a complement, a counter prunes.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const BASELINE = path.join(root, "test", "fixtures", "bench-baseline.json");

const { MemorySource } = await import("../src/byte-source.js");
const { IndexReader } = await import("../src/index-reader.js");
const { SearchSession } = await import("../src/search-session.js");
const { SessionContext } = await import("../src/session-context.js");
const { parsePhonetics } = await import("../src/phonetics.js");
const { parseWikiLists } = await import("../src/word-lists.js");

/** Query shapes, each stressing a different part of the engine. */
const CASES = [
  { name: "literal", query: "solar s_stem", steps: 200000 },
  // Reaches the step cap rather than exhausting, and that is correct: `nutr*`
  // is `nut` followed by any number of `r`s, and since word breaks are
  // optional "nut r", "nut r r", "nut r r r" are all matches, so the language
  // is infinite. It exhausted at 34 steps only while the engine was dropping
  // matches at word boundaries; fixing that revealed the real size of it.
  { name: "prefix", query: "nutr*", steps: 200000 },
  { name: "class-heavy", query: "A{5}&C*", steps: 200000 },
  { name: "anagram", query: "<aciimnrttu>", steps: 300000 },
  { name: "big-list", query: "{list:countries}", steps: 200000 },
  { name: "negation", query: "A{5}&!.*ee.*", steps: 200000 },
  { name: "counter", query: "{sum=52:A*}", steps: 200000 },
  { name: "multiset", query: "{distinct:A{6}}", steps: 200000 },
  { name: "phrase", query: "A{4} A{5}", steps: 200000 },
  // The harder end of each shape (T2). These were the parts the grid did not
  // reach: one negation is not three, two words are not three, a prefix walk is
  // not a suffix one, and a list of two hundred is not one of six hundred.
  { name: "deep-negation", query: "A{6}&!.*ee.*&!.*th.*&!.*ss.*", steps: 200000 },
  { name: "three-word", query: "A{3} A{3} A{3}", steps: 200000 },
  // Anchored at the end, which the trie cannot prune on: every path is a
  // candidate until its last letter.
  { name: "suffix-anchored", query: ".*tion", steps: 200000 },
  { name: "heavy-anagram", query: "<aaeilmnorstu>", steps: 300000 },
  // The biggest built-in list, now that the harvested catalogue is curated
  // (this slot used a 600-entry harvested list that the curation removed).
  { name: "huge-list", query: "{list:instruments}", steps: 200000 },
  // The other strategy: this one is answered by listing a conjunct out rather
  // than walking, so its step count is zero and the numbers that describe it
  // are the candidates tested and looked up. Without it the gate covers only
  // the walk, and half the engine could regress unnoticed.
  { name: "tested-list", query: "{rhyme:night}&A{5}", steps: 200000 },
];

const args = process.argv.slice(2);
const update = args.includes("--update");
const asJson = args.includes("--json");

const data = fs.readFileSync(path.join(root, "web", "public", "demo.index"));
const results = [];

for (const c of CASES) {
  // A fresh reader per case: a shared one carries a warm parse cache, which
  // makes a case's cost depend on the ones before it.
  const reader = await IndexReader.open(new MemorySource(data));
  // The datasets the harder cases name. Loaded per case for the same reason the
  // reader is fresh: a shared context carries a warm parse.
  const ctx = new SessionContext();
  if (/\{rhyme|\{homo/.test(c.query)) {
    ctx.phonetics = parsePhonetics(
      fs.readFileSync(path.join(root, "web", "public", "phonetics.txt"), "utf8"),
    );
  }
  if (/\{list:/.test(c.query)) {
    ctx.lists = parseWikiLists(
      fs.readFileSync(path.join(root, "web", "public", "lists.txt"), "utf8"),
    );
  }
  const session = new SearchSession(reader, c.query, ctx);
  const t0 = performance.now();
  await session.run(c.steps, 100000, () => {});
  const ms = performance.now() - t0;
  const s = session.stats();
  results.push({
    name: c.name,
    query: c.query,
    steps: s.steps,
    results: s.results,
    dfaStates: s.dfaStates,
    frontierPeak: s.frontierPeak,
    candidatesTested: s.candidatesTested,
    indexLookups: s.indexLookups,
    ms: Math.round(ms),
    stepsPerSec: Math.round(s.steps / (ms / 1000)),
  });
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

/** The fields that must not change without someone deciding they should. */
const pinned = (r) => ({
  steps: r.steps,
  results: r.results,
  dfaStates: r.dfaStates,
  frontierPeak: r.frontierPeak,
  // Zero for a walk, and the whole story for a case answered by testing a list.
  candidatesTested: r.candidatesTested,
  indexLookups: r.indexLookups,
});

if (update) {
  const out = Object.fromEntries(results.map((r) => [r.name, pinned(r)]));
  fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n");
  console.error(`wrote ${CASES.length} cases to ${path.relative(root, BASELINE)}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error(`no baseline at ${path.relative(root, BASELINE)} — run with --update`);
  process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

const problems = [];
for (const r of results) {
  const want = baseline[r.name];
  console.error(
    `  ${r.name.padEnd(12)} ${String(r.steps).padStart(7)} steps  ` +
      `${String(r.results).padStart(6)} results  ` +
      `${String(r.dfaStates).padStart(6)} dfa  ` +
      (r.candidatesTested
        ? `${String(r.candidatesTested).padStart(5)} tested  `
        : "") +
      `${String(r.ms).padStart(5)}ms  ` +
      `${(r.stepsPerSec / 1e6).toFixed(2)}M steps/s`,
  );
  if (!want) {
    problems.push(`${r.name}: no baseline (new case — run --update)`);
    continue;
  }
  for (const [k, v] of Object.entries(pinned(r))) {
    if (want[k] !== v) {
      problems.push(`${r.name}.${k}: ${want[k]} -> ${v}`);
    }
  }
}
for (const name of Object.keys(baseline)) {
  if (!results.some((r) => r.name === name)) {
    problems.push(`${name}: in the baseline but no longer run`);
  }
}

if (problems.length > 0) {
  console.error("\nengine behaviour changed:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nStep counts are exact for a given index and query, so a change means " +
      "the engine explores differently. If that was the point, re-run with " +
      "--update and say so in the commit.",
  );
  process.exit(1);
}

console.error(`\nbench OK: ${results.length} cases match the baseline`);
