// Testing a list against the index, instead of walking it.
//
// The whole value of this depends on one claim: it gives the same answers, in
// the same order, with the same scores, as the search it replaces. So that is
// what is tested — against the search itself, on every query the strategy will
// accept, rather than against fixtures someone wrote down.

import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";
import { compileConjuncts } from "../src/find-expr.js";
import { parseCategories } from "../src/categories.js";
import { parsePhonetics } from "../src/phonetics.js";
import { parseWikiLists } from "../src/word-lists.js";
import { Nfa } from "../src/automata.js";
import { innerNfa } from "../src/conjunct.js";
import {
  enumerateLanguage,
  finiteCandidates,
  finiteStrategy,
} from "../src/finite-strategy.js";

const ctx = new SessionContext();
let reader: IndexReader;

beforeAll(async () => {
  reader = await IndexReader.open(
    new MemorySource(fs.readFileSync("web/public/demo.index")),
  );
  ctx.categories = parseCategories(
    fs.readFileSync("web/public/categories.txt", "utf8"),
  );
  ctx.phonetics = parsePhonetics(
    fs.readFileSync("web/public/phonetics.txt", "utf8"),
  );
  ctx.lists = parseWikiLists(fs.readFileSync("web/public/lists.txt", "utf8"));
}, 120000);

/** Everything the ordinary search finds, run to exhaustion. */
async function byWalking(query: string) {
  const session = new SearchSession(reader, query, ctx);
  const out: Array<{ text: string; score: number }> = [];
  const status = await session.run(5e6, 1e6, (r) =>
    out.push({ text: r.text, score: r.score }),
  );
  return { out, status };
}

describe("enumerating a language", () => {
  it("gives every string an acyclic automaton accepts", () => {
    const nfa = new Nfa();
    const a = nfa.addState(), b = nfa.addState(), c = nfa.addState();
    nfa.setStart(a);
    nfa.setFinal(c);
    nfa.addArc(a, 0x61, b); // a
    nfa.addArc(a, 0x62, b); // b
    nfa.addArc(b, 0x63, c); // c
    expect(enumerateLanguage(nfa)?.sort()).toEqual(["ac", "bc"]);
  });

  it("refuses a language with a cycle rather than looping forever", () => {
    const nfa = new Nfa();
    const a = nfa.addState(), b = nfa.addState();
    nfa.setStart(a);
    nfa.setFinal(b);
    nfa.addArc(a, 0x61, b);
    nfa.addArc(b, 0x61, a); // a cycle
    expect(enumerateLanguage(nfa)).toBeNull();
  });

  it("gives each string once, however many ways it is spelled", () => {
    // Deleting either M of GAMMA gives GAMA. The walk emits it once, so this
    // has to as well — returning one string per path made the strategy report
    // eight extra results and broke engine parity, which is how it was found.
    const conjuncts = compileConjuncts("{del1:{list:greek}}", ctx);
    const picked = finiteCandidates(conjuncts);
    expect(picked).not.toBeNull();
    expect(new Set(picked!.strings).size).toBe(picked!.strings.length);
    expect(picked!.strings).toContain("gama");
  });

  it("refuses a language larger than the cap", () => {
    // `A{3}` is 17,576 strings, well past any sensible candidate list.
    const [conjunct] = compileConjuncts('"A{3}"', ctx);
    expect(enumerateLanguage(innerNfa(conjunct), 100)).toBeNull();
  });
});

describe("choosing which conjunct to enumerate", () => {
  it("takes the smallest", () => {
    const conjuncts = compileConjuncts("{list:greek}&{rhyme:night}", ctx);
    const picked = finiteCandidates(conjuncts);
    expect(picked, "nothing was enumerable").not.toBeNull();
    // Greek letters (24) rather than rhymes of NIGHT (103).
    expect(picked!.strings.length).toBeLessThan(50);
    expect(picked!.strings).toContain("alpha");
  });

  it("declines when a candidate contains a space", () => {
    // 68% of WordNet's birds are phrases — "bird of juno" — and a phrase may
    // be several index entries joined at a space, which a probe cannot price.
    expect(finiteCandidates(compileConjuncts("{kind:bird}", ctx))).toBeNull();
  });

  it("declines an unbounded conjunct", () => {
    expect(finiteCandidates(compileConjuncts("A{5}&C*", ctx))).toBeNull();
  });
});

// The claim the strategy stands on.
describe("the same answers as walking the index", () => {
  for (const query of [
    "{rhyme:night}",
    "{rhyme:night}&A{5}",
    "{list:greek}",
    "{list:greek}&A{5}",
    "{rhyme:tree}&C*",
    "{rhyme:night}&A{5}&!.*g.*",
    // The same string reachable several ways — see the dedup case above.
    "{del1:{list:greek}}",
  ]) {
    it(`agrees on ${query}`, async () => {
      const conjuncts = compileConjuncts(query, ctx);
      const tested = await finiteStrategy(reader, conjuncts);
      expect(tested, `${query} was not answerable this way`).not.toBeNull();

      const { out: walked, status } = await byWalking(query);
      // A partial walk would make "the same set" meaningless.
      expect(status, `${query} did not exhaust`).toBe("exhausted");

      expect(tested!.map((r) => r.text)).toEqual(walked.map((r) => r.text));
      for (let i = 0; i < walked.length; ++i) {
        expect(tested![i].score, tested![i].text).toBe(walked[i].score);
      }
    }, 120000);
  }

  it("compares against something rather than nothing", async () => {
    const { out } = await byWalking("{rhyme:night}&A{5}");
    expect(out.length).toBeGreaterThan(3);
  }, 60000);
});
