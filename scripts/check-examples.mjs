// Every documented example must actually find something.
//
//   node scripts/check-examples.mjs
//
// The catalogue gives all 45 constructs a runnable example, and a unit test
// already checks that each one *parses*. Parsing is not the bar. Two of them
// spent this session returning visible nonsense — `{reversible:A{4}}` led with
// THAT (reversed: "taht", which a web corpus contains) and `{compound 2:A{9}}`
// cut AVAILABLE into "avai" and "lable" — and both parsed perfectly the whole
// time. A third, `{del1:}`, once compiled to the empty language. None of that
// is visible without running the query against a real index.
//
// So this searches every example against the committed demo.index, with the
// side datasets loaded, and fails if one finds nothing or throws. It is the
// standing answer to "does every feature still work", which is otherwise a
// question nobody asks until a user does.
//
// Two sources of examples, because both are promises to a reader. The 45
// constructs in the catalogue carry one each. The pages carry another 97
// between them — every `?q=` link on the front page, the usage guide and the
// recipes page — and `check-links` only proves those *say* what they search,
// not that searching them finds anything.
//
// It cannot check that the results are *right* — no fixture says what
// {rot180:A{4}} ought to return — so it checks the two things it can: the
// query runs, and the feature is not silently dead.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CONSTRUCTS } from "../src/constructs.js";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";
import { makeWordChecker } from "../src/index-words.js";
import { parseFilterWrappers } from "../src/result-filter.js";
import { applyResultFilters } from "../src/result-predicate.js";
import { parsePhonetics } from "../src/phonetics.js";
import { parseThesaurus } from "../src/thesaurus.js";
import { parseCategories } from "../src/categories.js";
import { parseStress } from "../src/stress.js";
import { parseNeighbours } from "../src/neighbours.js";
import { parseWikiLists } from "../src/word-lists.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = (f) => path.join(root, "web", "public", f);

// Examples the demo index cannot satisfy, with the reason. Not a list of
// things that are broken — a list of things this corpus cannot answer, which
// is a property of the fixture and not of the feature.
const UNSATISFIABLE = {
  // demo.index is "web words + bigrams": it has no three-word phrase to find.
  // Verified against the full Wikipedia index, where {words=3:A*} returns
  // "wikipedia articles for", "articles for deletion", "should be made".
  words: "demo.index holds words and bigrams only, so no match has three words",
};

/** Page examples the demo index cannot satisfy, with the reason. */
const UNSATISFIABLE_QUERIES = new Map([
  [
    "{words=3:A*}",
    "demo.index holds words and bigrams only, so no match has three words",
  ],
  [
    "<het><ral><seg><tan><rut><bla><oody><afl><ndi><cin><awe><ter>",
    "the usage guide gives this hunt's answer as \"the largest natural body " +
      "of land in ice water\" — nine words, and demo.index holds words and " +
      "bigrams",
  ],
]);

const ctx = new SessionContext();
ctx.phonetics = parsePhonetics(fs.readFileSync(pub("phonetics.txt"), "utf8"));
ctx.thesaurus = parseThesaurus(fs.readFileSync(pub("thesaurus.txt"), "utf8"));
ctx.categories = parseCategories(fs.readFileSync(pub("categories.txt"), "utf8"));
ctx.stress = parseStress(fs.readFileSync(pub("stress.txt"), "utf8"));
ctx.lists = parseWikiLists(fs.readFileSync(pub("lists.txt"), "utf8"));
ctx.neighbours = parseNeighbours(
  fs.readFileSync(pub("neighbours.bin")).buffer,
);

const data = fs.readFileSync(pub("demo.index"));

// A predicate is checked *after* the search, so most candidates are thrown
// away and it needs a wide net; an automaton-level construct is satisfied by
// the search itself and needs almost none.
const STEPS = 400000;

/** The `?q=` example links on the pages, as the queries they claim to run. */
function pageExamples() {
  const unescape = (t) =>
    t
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'");
  const found = new Map(); // query -> the file it was first seen in
  for (const file of ["web/index.html", "web/public/usage.html", "web/public/recipes.html"]) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    const html = fs.readFileSync(full, "utf8");
    // Markup inside the anchor is the house style on the recipes page; the
    // label, not the href, is the query, exactly as check-links pins it.
    for (const m of html.matchAll(/<a href="[^"?]*\?q=([^"]*)"[^>]*>(.*?)<\/a>/gs)) {
      const label = unescape(m[2].replace(/<[^>]*>/g, "")).split(/\s+/).join(" ").trim();
      if (label.includes("…")) continue; // prose, not a runnable query
      if (!found.has(label)) found.set(label, file);
    }
  }
  return found;
}

/** Run one example the way the page does, and return its first few answers. */
async function answersFor(query) {
  // The same peel both front ends use, so a documented query is checked as
  // the page reads it.
  const { specs, inner } = parseFilterWrappers(query.trim());
  const reader = await IndexReader.open(new MemorySource(data));
  const isWord = makeWordChecker(reader);
  const session = new SearchSession(reader, inner, ctx);

  const candidates = [];
  await session.run(STEPS, specs.length > 0 ? 20000 : 200, (r) =>
    candidates.push(r.text),
  );

  const kept = [];
  for (const text of candidates) {
    if (specs.length > 0) {
      const verdict = await applyResultFilters(specs, text, ctx, isWord);
      if (!verdict.keep) continue;
    }
    kept.push(text);
    if (kept.length >= 3) break;
  }
  return kept;
}

const problems = [];
let checked = 0;
let skipped = 0;

for (const c of CONSTRUCTS) {
  const name = `${c.group}.${c.name}`;
  let answers = null;
  let failure = null;
  try {
    answers = await answersFor(c.example);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }

  if (failure !== null) {
    problems.push(`${name}: ${c.example} threw — ${failure}`);
    continue;
  }
  if (answers.length === 0) {
    const why = UNSATISFIABLE[c.name];
    if (why) {
      ++skipped;
      console.error(`  ${name}: no results — expected, ${why}`);
      continue;
    }
    problems.push(`${name}: ${c.example} found nothing`);
    continue;
  }
  // A construct on the skip list that starts working means the fixture
  // changed under it, and the entry is now a lie.
  if (UNSATISFIABLE[c.name]) {
    problems.push(
      `${name}: listed as unsatisfiable on demo.index but returned ` +
        `${answers.join(", ")} — remove it from UNSATISFIABLE`,
    );
    continue;
  }
  ++checked;
}

// The same question of the pages: every runnable `?q=` link must find
// something. `check-links` proves a link searches what its label says; this
// proves the label is worth searching.
let pagesChecked = 0;
let pagesSkipped = 0;
for (const [query, file] of pageExamples()) {
  let answers = null;
  let failure = null;
  try {
    answers = await answersFor(query);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  const where = `${file}: ${query}`;
  if (failure !== null) {
    problems.push(`${where} threw — ${failure}`);
    continue;
  }
  if (answers.length === 0) {
    const why = UNSATISFIABLE_QUERIES.get(query);
    if (why) {
      ++pagesSkipped;
      console.error(`  ${where}: no results — expected, ${why}`);
      continue;
    }
    problems.push(`${where} found nothing`);
    continue;
  }
  if (UNSATISFIABLE_QUERIES.has(query)) {
    problems.push(
      `${where} is listed as unsatisfiable on demo.index but returned ` +
        `${answers.join(", ")} — remove it from UNSATISFIABLE_QUERIES`,
    );
    continue;
  }
  ++pagesChecked;
}

if (problems.length > 0) {
  console.error("\ndocumented examples that do not work:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} broken.`);
  process.exit(1);
}

console.error(
  `examples OK: ${checked} construct examples and ${pagesChecked} page links ` +
    `found results; ${skipped + pagesSkipped} skipped as unsatisfiable on ` +
    `this index`,
);
