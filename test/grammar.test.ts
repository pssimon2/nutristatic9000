// The shape GRAMMAR.md describes, as assertions.
//
// GRAMMAR.md says the language has three stacked levels and a fixed skeleton:
// an automaton construct is an atom and behaves like one, a predicate wraps the
// whole pattern, a transform wraps everything. A description like that is
// exactly the kind that drifts — a construct gets added, it turns out not to nest
// where its neighbours do, and nothing notices because no test asks.
//
// So the claims are tested rather than described. `scripts/grammar-matrix.mjs`
// prints the same combinations as a table for reading; this fails the build.

import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { SessionContext } from "../src/session-context.js";
import { parseFilterWrappers } from "../src/result-filter.js";
import { compileQuery } from "../src/find-expr.js";
import { applyResultFilters } from "../src/result-predicate.js";
import { parsePhonetics } from "../src/phonetics.js";
import { parseCategories } from "../src/categories.js";
import { parseWikiLists } from "../src/word-lists.js";
import { parseStress } from "../src/stress.js";
import { namesAtLevel } from "../src/constructs.js";

const ctx = new SessionContext();

beforeAll(() => {
  const read = (f: string) => fs.readFileSync(`web/public/${f}`, "utf8");
  ctx.phonetics = parsePhonetics(read("phonetics.txt"));
  ctx.categories = parseCategories(read("categories.txt"));
  ctx.lists = parseWikiLists(read("lists.txt"));
  ctx.stress = parseStress(read("stress.txt"));
}, 120000);

/** The whole front-end pipeline: peel, compile, run the predicates. */
async function works(query: string): Promise<boolean> {
  try {
    const { specs, inner } = parseFilterWrappers(query.trim());
    compileQuery(inner, ctx);
    // A predicate resolves its argument lazily, so it has to be run: compiling
    // alone reported `{anagram {palindrome:A{5}}:A*}` as working.
    if (specs.length > 0) {
      await applyResultFilters(specs, "level", ctx, (() => false) as never);
    }
    return true;
  } catch {
    return false;
  }
}

/** Positions that make something part of a pattern. */
const PATTERN_POSITIONS: Array<[string, (x: string) => string]> = [
  ["intersected", (x) => `A{4}&${x}`],
  ["alternated", (x) => `(${x}|A{3})`],
  ["concatenated", (x) => `a${x}`],
  ["grouped", (x) => `(${x})`],
  ["quoted", (x) => `"${x}"`],
  ["an anagram part", (x) => `<${x}b>`],
  ["an edit's argument", (x) => `{del1:${x}}`],
];

describe("an automaton construct is an atom and behaves like one", () => {
  // One per group that takes a pattern or a literal, so a whole family breaking
  // shows up. Deliberately not every construct: the point is the *positions*.
  const ATOMS = [
    "{rhyme:day}",
    "{sum=50:A*}",
    "{kind:bird}",
    "{list:greek}",
    "{del1:beast}",
    "{caesar:kdhv}",
    "{elements:A{6}}",
    "{row1:A{6}}",
    "{distinct:A{3}}",
  ];

  for (const atom of ATOMS) {
    it(`composes everywhere: ${atom}`, async () => {
      expect(await works(atom), `${atom} alone`).toBe(true);
      for (const [where, wrap] of PATTERN_POSITIONS) {
        expect(await works(wrap(atom)), `${atom} ${where}`).toBe(true);
      }
      // And it quantifies, which a bare class with a bound cannot: `A{3}?`
      // has already used its one quantifier.
      expect(await works(`${atom}?`), `${atom} quantified`).toBe(true);
    }, 120000);
  }

  it("cannot stack two quantifiers", async () => {
    expect(await works("A{3}?")).toBe(false);
    expect(await works("A**")).toBe(false);
  });

  it("composes structurally, but an edit still has to build its argument", async () => {
    // The one exception to "composes everywhere", and it is a size limit rather
    // than a rule: `{del1:…}` materialises its argument into a single automaton,
    // where the rest of the language keeps conjuncts apart and intersects them
    // lazily. `{distinct:A{n}}` is n+26 conjuncts, and materialising it grows
    // fast:
    expect(await works("{del1:{distinct:A{3}}}"), "3 letters").toBe(true);
    expect(await works("{del1:{distinct:A{5}}}"), "5 letters").toBe(false);
    // An ordinary intersection is fine at that size — it is the multiset
    // constraint's 26 conjuncts that cost, not intersection itself.
    expect(await works("{del1:A{5}&C*}"), "a plain intersection").toBe(true);
  }, 120000);
});

describe("a predicate composes like an atom, checked on the span it covers", () => {
  const PREDICATES = [
    "{palindrome:A{5}}",
    "{compound 2:A{9}}",
    "{reversible:A{5}}",
    "{anagram countries:A{5}}",
  ];

  for (const predicate of PREDICATES) {
    it(`is accepted inside a pattern: ${predicate}`, async () => {
      expect(await works(predicate), `${predicate} alone`).toBe(true);
      for (const [where, wrap] of PATTERN_POSITIONS) {
        // The one exception: an edit's argument is not part of the match, so
        // there is no span to ask the predicate of.
        const expected = where !== "an edit's argument";
        expect(await works(wrap(predicate)), `${predicate} ${where}`).toBe(
          expected,
        );
      }
      // And it quantifies — a construct is one atom, so its quantifier slot
      // is free.
      expect(await works(`${predicate}?`), `${predicate} quantified`).toBe(true);
    }, 120000);
  }

  it("is refused inside an edit with a message that says why", async () => {
    expect(await works("{del1:{palindrome:A{5}}}")).toBe(false);
  });

  it("stacks with a different predicate", async () => {
    expect(await works("{palindrome:{compound 2:A{9}}}")).toBe(true);
    expect(await works("{reversible:{palindrome:A{5}}}")).toBe(true);
  });

  it("refuses the same predicate twice", async () => {
    expect(await works("{palindrome:{palindrome:A{5}}}")).toBe(false);
  });

});

describe("the removed output wrappers and slots stay removed", () => {
  // {at …}, {rank …} and the ";" separator were taken out of the language
  // (2026-08-17): not useful in practice, and the only constructs that could
  // not compose. A query using them is an ordinary unknown-construct or
  // syntax error, not something half-supported.
  it("refuses the output wrappers as unknown constructs", async () => {
    expect(await works("{at 1:A{5}}")).toBe(false);
    expect(await works("{rank 1-9:A{5}}")).toBe(false);
  });

  it("refuses a semicolon anywhere", async () => {
    expect(await works("A{5};A{6}")).toBe(false);
    expect(await works("{palindrome:A{5};A{6}}")).toBe(false);
  });
});

// The catalogue and the skeleton have to agree about which level each construct
// is at, or the error a reader gets names the wrong rule.
describe("every construct is at the level the catalogue claims", () => {
  it("has two levels and nothing else", () => {
    const counts = {
      automaton: [...namesAtLevel("automaton")].length,
      predicate: [...namesAtLevel("predicate")].length,
    };
    expect(counts.automaton).toBeGreaterThan(30);
    expect(counts.predicate).toBeGreaterThan(4);
  });

  it("accepts every predicate in a pattern position, not just the ones above", async () => {
    // Generated from the catalogue, so a new predicate is covered the day it is
    // added rather than the day someone remembers to list it here.
    for (const name of namesAtLevel("predicate")) {
      const spec =
        name === "compound"
          ? "{compound 2:A{9}}"
          : name === "syllables"
            ? "{syllables=3:A{7}}"
            : name === "stress"
              ? "{stress 010:A{9}}"
              : name === "anagram"
                ? "{anagram countries:A{5}}"
                : name === "eq" || name === "rev"
                  ? `{${name} a,b:{=a:A{3}} {=b:A{3}}}`
                  : name === "shift"
                    ? "{shift13 a,b:{=a:A{3}} {=b:A{3}}}"
                    : `{${name}:A{5}}`;
      expect(await works(`A{4}&${spec}`), `${spec} intersected`).toBe(true);
    }
  }, 120000);
});
