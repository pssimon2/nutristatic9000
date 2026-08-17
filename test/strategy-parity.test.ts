// Two ways to answer a query, told to disagree.
//
// The engine has a second strategy now: a query with one small finite conjunct
// is answered by listing that conjunct out and testing each string, rather than
// by walking the trie (P4). It is only worth having if the two give the *same*
// answers, in the same order, with the same scores — and `finite-strategy.test`
// asserts that over seven queries someone chose.
//
// Seven queries pin the shapes someone thought of. These are generated from the
// pieces instead, so they cover combinations nobody wrote down: a rhyme set
// narrowed by a negation and a length, a deletion of a list, an edit crossed
// with a letter class. Seeded, so a failure names the query and can be replayed.
//
// The same idea for the complement (E1): a negated conjunct is walked lazily as
// a ComplementFilter, and the kernel needs it built out eagerly. Those two must
// accept the same language, which is a property no test asserted directly.

import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";
import { compileConjuncts } from "../src/find-expr.js";
import { finiteStrategy } from "../src/finite-strategy.js";
import { makeFilter } from "../src/expr-filter.js";
import { complement, trim } from "../src/automata.js";
import { innerNfa, isNegated } from "../src/conjunct.js";
import { parsePhonetics } from "../src/phonetics.js";
import { parseWikiLists } from "../src/word-lists.js";

const ctx = new SessionContext();
let reader: IndexReader;

beforeAll(async () => {
  reader = await IndexReader.open(
    new MemorySource(fs.readFileSync("web/public/demo.index")),
  );
  ctx.phonetics = parsePhonetics(
    fs.readFileSync("web/public/phonetics.txt", "utf8"),
  );
  ctx.lists = parseWikiLists(fs.readFileSync("web/public/lists.txt", "utf8"));
}, 120000);

/** Deterministic PRNG (mulberry32), so a failing case is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A query with one small finite conjunct, so the strategy has something to
 * enumerate, plus nothing to a couple of narrowings that do not.
 */
function randomQuery(rand: () => number): string {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const base = pick([
    "{list:greek}",
    "{rhyme:night}",
    "{rhyme:tree}",
    "{del1:beast}",
    "{subst1:cargo}",
    "{del1:{list:greek}}",
    "{add1:cargo}",
  ]);
  const narrowings = [
    "",
    "",
    `A{${3 + Math.floor(rand() * 4)}}`,
    "C*",
    "V*",
    ".*a.*",
    ".*e.*",
    "!.*e.*",
    "!.*a.*",
    "_*",
  ];
  const n = Math.floor(rand() * 3);
  const parts = [base];
  for (let i = 0; i < n; ++i) {
    const p = pick(narrowings);
    if (p !== "") parts.push(p);
  }
  return parts.join("&");
}

/** Everything the walk finds, run to exhaustion. */
async function byWalking(query: string) {
  const session = new SearchSession(reader, query, ctx, undefined, {
    forceWalk: true,
  });
  const out: Array<{ text: string; score: number }> = [];
  const status = await session.run(5e6, 1e6, (r) =>
    out.push({ text: r.text, score: r.score }),
  );
  return { out, status };
}

describe("listing a conjunct out agrees with walking the index", () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`agrees on 25 generated queries from seed ${seed}`, async () => {
      const rand = rng(seed);
      let compared = 0;
      for (let i = 0; i < 25; ++i) {
        const query = randomQuery(rand);
        let conjuncts;
        try {
          conjuncts = compileConjuncts(query, ctx);
        } catch {
          continue; // not a valid query: not what this tests
        }
        const tested = await finiteStrategy(reader, conjuncts);
        if (tested === null) continue; // the walk is the only way: fine

        const { out: walked, status } = await byWalking(query);
        // A partial walk would make "the same answers" meaningless. "empty" is
        // a finished walk too: the emptiness check settles some of these from
        // the automaton without walking at all — `{del1:beast}&A{6}` cannot
        // match, since BEAST minus a letter is four long — and then both sides
        // must produce nothing.
        expect(
          ["exhausted", "empty"],
          `${query} (seed ${seed}) ended as ${status}`,
        ).toContain(status);
        ++compared;
        if (status === "empty") {
          expect(walked, `${query}: an empty walk found something`).toEqual([]);
          expect(
            tested.results,
            `${query}: the walk proved it empty and the test did not`,
          ).toEqual([]);
          continue;
        }
        expect(
          tested.results.map((r) => r.text),
          `${query} (seed ${seed}): texts`,
        ).toEqual(walked.map((r) => r.text));
        for (let j = 0; j < walked.length; ++j) {
          expect(
            tested.results[j].score,
            `${query} (seed ${seed}): score of ${walked[j].text}`,
          ).toBe(walked[j].score);
        }
      }
      // A generator that mostly produced queries the strategy declines would
      // pass this while testing nothing.
      expect(compared, "queries actually compared").toBeGreaterThan(8);
    }, 120000);
  }
});

// The other pair the engine keeps: a negation walked lazily, and the same
// negation built out.
describe("a lazy complement accepts what an eager one does", () => {
  /** Does the filter accept this exact string? */
  function accepts(
    filter: ReturnType<typeof makeFilter>,
    s: string,
  ): boolean {
    let state = filter.startState;
    for (const ch of s) {
      state = filter.transition(state, ch.charCodeAt(0));
      if (state < 0) return false;
    }
    return filter.isAccepting(state);
  }

  for (const query of [
    "A{5}&!.*ee.*",
    "A{4}&!.*a.*",
    "A{5}&!C*",
    '"A{4}"&!.*e.*',
    "A{6}&!.*th.*&C*",
  ]) {
    it(`agrees on ${query}`, () => {
      const conjuncts = compileConjuncts(query, ctx);
      const negated = conjuncts.filter(isNegated);
      expect(negated.length, `${query} has no negation to test`).toBe(1);

      const lazy = makeFilter(conjuncts);
      // The same query with the complement built out, which is what the WASM
      // kernel is given.
      const built = complement(innerNfa(negated[0]));
      expect(built, `${query}: complement did not build`).not.toBeNull();
      const eager = makeFilter(
        conjuncts.map((c) => (isNegated(c) ? trim(built!) : c)),
      );

      // Every string over a small alphabet up to a length both can decide.
      const alphabet = "aecth ";
      let checked = 0;
      const walk = (s: string): void => {
        if (s.length > 0) {
          expect(accepts(eager, s), `${query}: ${JSON.stringify(s)}`).toBe(
            accepts(lazy, s),
          );
          ++checked;
        }
        if (s.length >= 6) return;
        for (const c of alphabet) walk(s + c);
      };
      walk("");
      expect(checked, "nothing was compared").toBeGreaterThan(1000);
    }, 120000);
  }
});
