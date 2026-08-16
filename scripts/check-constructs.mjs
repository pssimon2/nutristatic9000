// Every documented construct must actually find something.
//
//   node scripts/check-constructs.mjs
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
import { shapeOfQuery } from "../src/query-shape.js";
import { parseFilterWrappers } from "../src/result-filter.js";
import { applyResultFilters } from "../src/result-predicate.js";
import { OutputTransform } from "../src/output.js";
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

/** Run one example the way the page does, and return its first few answers. */
async function answersFor(query) {
  const shaped = shapeOfQuery(query, 12);
  const { specs, inner } = parseFilterWrappers(shaped.pattern);
  const reader = await IndexReader.open(new MemorySource(data));
  const isWord = makeWordChecker(reader);
  const out = new OutputTransform(shaped.extract, shaped.rank);
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
    const shown = out.apply(text);
    if (shown) kept.push(shown.text);
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

if (problems.length > 0) {
  console.error("\nconstructs whose documented example does not work:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} of ${CONSTRUCTS.length} are broken.`);
  process.exit(1);
}

console.error(
  `constructs OK: ${checked} examples found results, ` +
    `${skipped} skipped as unsatisfiable on this index`,
);
