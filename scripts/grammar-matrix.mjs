// What composes with what, measured rather than remembered.
//
//   npx tsx scripts/grammar-matrix.mjs             # the table in GRAMMAR.md §4
//   npx tsx scripts/grammar-matrix.mjs 'query' …   # probe specific queries
//
// GRAMMAR.md describes a language with three stacked levels and a fixed
// skeleton. A description like that is exactly the kind that drifts: a construct
// gets added, it turns out not to nest where its neighbours do, and nothing
// notices because no test asks. So the table is generated from the code by
// running each construct through each syntactic position.
//
// It runs the *whole* front-end pipeline — split the slots, peel the wrappers,
// compile the pattern, and then run the predicates once — because a predicate
// validates its argument lazily, at match time. Compiling alone reported
// `{anagram {palindrome:A{5}}:A*}` as working when it does not, which is how the
// first version of this table came out wrong.

import * as fs from "node:fs";

const { SessionContext } = await import("../src/session-context.js");
const { planSlots } = await import("../src/slot-plan.js");
const { compileQuery } = await import("../src/find-expr.js");
const { applyResultFilters } = await import("../src/result-predicate.js");
const { parsePhonetics } = await import("../src/phonetics.js");
const { parseCategories } = await import("../src/categories.js");
const { parseWikiLists } = await import("../src/word-lists.js");
const { parseStress } = await import("../src/stress.js");

const ctx = new SessionContext();
const read = (f) => fs.readFileSync(`web/public/${f}`, "utf8");
ctx.phonetics = parsePhonetics(read("phonetics.txt"));
ctx.categories = parseCategories(read("categories.txt"));
ctx.lists = parseWikiLists(read("lists.txt"));
ctx.stress = parseStress(read("stress.txt"));

/** Does this query work, and if not, what does it say? */
async function tryQuery(q) {
  try {
    const slots = planSlots(q, 12);
    if (slots.length === 0) return { ok: false, why: "no slots" };
    for (const s of slots) compileQuery(s.pattern, ctx);
    for (const s of slots) {
      // One match is enough to make a predicate resolve its argument.
      if (s.filters.length > 0) {
        await applyResultFilters(s.filters, "level", ctx, () => false);
      }
    }
    return { ok: true, slots };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, why: m.split("\n")[0] };
  }
}

const probes = process.argv.slice(2);
if (probes.length > 0) {
  for (const q of probes) {
    const r = await tryQuery(q);
    if (!r.ok) {
      console.log(`${q}\n   NO  ${r.why}`);
      continue;
    }
    console.log(`${q}\n   ok  ${r.slots.length} slot(s)`);
    for (const s of r.slots) {
      console.log(
        `       pattern ${JSON.stringify(s.pattern).padEnd(14)}` +
          ` predicates [${s.filters.map((f) => f.kind).join(",")}]` +
          `${s.extract ? " at" : ""}${s.rank ? " rank" : ""}`,
      );
    }
  }
  process.exit(0);
}

/** One construct per level, plus a plain class to stand for the pattern itself. */
const SUBJECTS = [
  ["A{3}", "automaton"],
  ["{rhyme:day}", "automaton"],
  ["{sum=50:A*}", "automaton"],
  ["{kind:bird}", "automaton"],
  ["{list:greek}", "automaton"],
  ["{del1:beast}", "automaton"],
  ["{caesar:kdhv}", "automaton"],
  ["{elements:A{6}}", "automaton"],
  ["{palindrome:A{5}}", "predicate"],
  ["{compound 2:A{9}}", "predicate"],
  ["{anagram countries:A{5}}", "predicate"],
  ["{at 1:A{5}}", "transform"],
  ["{rank 1-9:A{5}}", "transform"],
];

/** Every syntactic position something can be written in. */
const POSITIONS = [
  ["alone", (x) => x],
  ["`A&X`", (x) => `A{4}&${x}`],
  ["`(X\\|A)`", (x) => `(${x}|A{3})`],
  ["`aX`", (x) => `a${x}`],
  ["`X?`", (x) => `${x}?`],
  ["`(X)`", (x) => `(${x})`],
  ['`"X"`', (x) => `"${x}"`],
  ["`<Xb>`", (x) => `<${x}b>`],
  ["`{del1:X}`", (x) => `{del1:${x}}`],
  ["`{anagram X:A*}`", (x) => `{anagram ${x}:A*}`],
  ["`{palindrome:X}`", (x) => `{palindrome:${x}}`],
  ["`{at 1:X}`", (x) => `{at 1:${x}}`],
  ["`X;A{3}`", (x) => `${x};A{3}`],
];

console.log(`| | ${POSITIONS.map(([n]) => n).join(" | ")} |`);
console.log(`|${"---|".repeat(POSITIONS.length + 1)}`);
const failures = [];
for (const [subject] of SUBJECTS) {
  const cells = [];
  for (const [name, wrap] of POSITIONS) {
    const q = wrap(subject);
    const r = await tryQuery(q);
    cells.push(r.ok ? "ok" : "–");
    if (!r.ok) failures.push(`${q}\n    ${r.why}`);
  }
  console.log(`| \`${subject}\` | ${cells.join(" | ")} |`);
}

console.error(`\n${failures.length} combinations do not compose, with reasons:\n`);
for (const f of failures) console.error(`  ${f}\n`);
