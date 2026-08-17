// Regenerate the large `{list:…}` categories from Wikidata.
//
//   node scripts/build-lists.mjs            # rewrite src/word-lists-data.ts
//   node scripts/build-lists.mjs countries  # just one, printed, nothing written
//
// Wikidata rather than scraping Wikipedia's "List of …" pages: the data is
// structured (no HTML parsing, no per-page format drift) and it is CC0, so
// the entries carry no licence obligation the way Wikipedia's CC BY-SA prose
// would. The small canonical sets — the seven deadly sins, the nine muses —
// stay hand-written in word-lists.ts, where typing them is more reliable than
// querying for them.
//
// The generated file is committed, so a clean clone and CI never need network.

import fs from "node:fs";

const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "nutristatic-list-builder/1.0 (https://nutristatic.org/)";

/** Entries longer than the index window can never match anything. */
const MAX_ENTRY = 40;

/**
 * Fold diacritics the way the index build does (tools/latin-fold.sed), so an
 * entry can actually match the corpus. Without this "Boötes" normalises to
 * "bo tes" — the diaeresis becomes a separator — and matches nothing.
 */
function foldDiacritics(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Same normalisation as src/word-lists.ts, kept in step by hand. */
function normalizeEntry(s) {
  return foldDiacritics(s)
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Labels carrying a disambiguator or a formal prefix are not what a solver
 * writes: "Georgia (country)" is GEORGIA, and the long-form state names are
 * never the puzzle answer.
 */
function tidy(label) {
  return label
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/^(the\s+)?(republic|kingdom|state|commonwealth|principality|federation|union|grand duchy|sultanate|emirate)\s+of\s+/i, "")
    .replace(/^people'?s\s+republic\s+of\s+/i, "");
}

const QUERIES = {
  countries: `
    SELECT DISTINCT ?label WHERE {
      ?c wdt:P31 wd:Q3624078 .
      FILTER NOT EXISTS { ?c wdt:P576 ?dissolved }
      ?c rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  capitals: `
    SELECT DISTINCT ?label WHERE {
      ?c wdt:P31 wd:Q3624078 ; wdt:P36 ?cap .
      FILTER NOT EXISTS { ?c wdt:P576 ?dissolved }
      ?cap rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  usstates: `
    SELECT DISTINCT ?label WHERE {
      ?s wdt:P31 wd:Q35657 .
      ?s rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  elements: `
    SELECT DISTINCT ?label WHERE {
      ?e wdt:P31 wd:Q11344 .
      ?e rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  constellations: `
    SELECT DISTINCT ?label WHERE {
      ?c wdt:P31 wd:Q8928 .
      ?c rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  greekgods: `
    SELECT DISTINCT ?label WHERE {
      ?g wdt:P31 wd:Q22989102 .
      ?g rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  norsegods: `
    SELECT DISTINCT ?label WHERE {
      ?g wdt:P31 wd:Q16513881 .
      ?g rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  dogbreeds: `
    SELECT DISTINCT ?label WHERE {
      ?d wdt:P31 wd:Q39367 .
      ?d rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  instruments: `
    SELECT DISTINCT ?label WHERE {
      # The subclass tree below "musical instrument": violins and vielles are
      # types, not instances. An English Wikipedia article keeps it to the
      # instruments a person may actually have heard of.
      ?i wdt:P279* wd:Q34379 .
      ?art schema:about ?i ;
           schema:isPartOf <https://en.wikipedia.org/> .
      ?i rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  carmakers: `
    SELECT DISTINCT ?label WHERE {
      { ?m wdt:P31 wd:Q786820 . } UNION { ?m wdt:P31 wd:Q56065404 . }
      ?art schema:about ?m ;
           schema:isPartOf <https://en.wikipedia.org/> .
      ?m rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  sports: `
    SELECT DISTINCT ?label WHERE {
      # The subclass tree only: kinds of sport, not individual events — the
      # instance closure drags in every named marathon.
      ?s wdt:P279* wd:Q31629 .
      ?art schema:about ?s ;
           schema:isPartOf <https://en.wikipedia.org/> .
      ?s rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  currencies: `
    SELECT DISTINCT ?label WHERE {
      ?c wdt:P31 wd:Q8142 .
      ?art schema:about ?c ;
           schema:isPartOf <https://en.wikipedia.org/> .
      ?c rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
  presidents: `
    SELECT DISTINCT ?label WHERE {
      ?p p:P39 ?st . ?st ps:P39 wd:Q11696 .
      # Wikidata records fictional office-holders too — Doctor Doom and the
      # president from Designated Survivor both hold this position. Real
      # people only.
      ?p wdt:P31 wd:Q5 .
      ?st pq:P580 ?start .
      ?p wdt:P734 ?surname .
      ?surname rdfs:label ?label . FILTER(lang(?label) = "en")
    }`,
};

async function sparql(query) {
  const url = `${ENDPOINT}?query=${encodeURIComponent(query)}`;
  for (let attempt = 0; ; ++attempt) {
    try {
      const r = await fetch(url, {
        headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      return json.results.bindings.map((b) => b.label.value);
    } catch (e) {
      if (attempt >= 3) throw e;
      // The public endpoint rate-limits; back off rather than hammer it.
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

/**
 * Class-tree lists (instruments, sports) leak digit-named oddities through
 * the subclass closure — artillery "instruments", model numbers. A name with
 * a digit in it is never the puzzle answer these lists exist for.
 */
const NO_DIGITS = new Set(["instruments", "carmakers", "sports", "currencies"]);

async function buildList(name) {
  const labels = await sparql(QUERIES[name]);
  const seen = new Set();
  for (const raw of labels) {
    const e = normalizeEntry(tidy(raw));
    // Drop empties, over-long entries, and anything that still looks like an
    // identifier rather than a name (stray digits from Wikidata Q-labels).
    if (!e || e.length > MAX_ENTRY) continue;
    if (/^q\d+$/.test(e)) continue;
    if (NO_DIGITS.has(name) && /\d/.test(e)) continue;
    // "alpine skiing at the winter olympics" is an event article, not a
    // sport; the phrasing gives it away.
    if (name === "sports" && / at the | in the /.test(e)) continue;
    seen.add(e);
  }
  return [...seen].sort();
}

const only = process.argv[2];
const names = only ? [only] : Object.keys(QUERIES);
if (only && !QUERIES[only]) {
  console.error(`no such list "${only}" — have: ${Object.keys(QUERIES).join(", ")}`);
  process.exit(2);
}

const out = {};
for (const name of names) {
  process.stderr.write(`${name}… `);
  const entries = await buildList(name);
  out[name] = entries;
  process.stderr.write(`${entries.length}\n`);
}

if (only) {
  // Comma-separated: entries may contain spaces.
  console.log(out[only].join(","));
  process.exit(0);
}

/** Wrap a long entry list into readable source lines. */
function wrap(entries) {
  // Comma-separated: a space is legal inside an entry ("united states"), so
  // it cannot double as the separator.
  const lines = [];
  let line = "";
  for (const e of entries) {
    if (line.length + e.length + 1 > 70) {
      lines.push(line);
      line = "";
    }
    line += e + ",";
  }
  if (line) lines.push(line);
  const joined = lines.map((l) => `    "${l}"`).join(" +\n");
  // Drop the trailing comma of the last line.
  return joined.replace(/,"$/, '"');
}

const body = Object.entries(out)
  .map(([name, entries]) => `  ${name}:\n${wrap(entries)},`)
  .join("\n");

const file = `// GENERATED by scripts/build-lists.mjs — do not edit by hand.
//
// Large \`{list:…}\` categories sourced from Wikidata (CC0). Regenerate with
// \`node scripts/build-lists.mjs\`; the file is committed so clean clones and
// CI need no network. Small canonical sets are hand-written in word-lists.ts.
//
// Counts at generation time: ${Object.entries(out)
    .map(([n, e]) => `${n} ${e.length}`)
    .join(", ")}.

export const GENERATED_LISTS: Record<string, string> = {
${body}
};
`;

fs.writeFileSync("src/word-lists-data.ts", file);
console.error(`wrote src/word-lists-data.ts`);
