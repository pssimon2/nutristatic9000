// Patterns that cannot match anything, found before the search rather than
// after it.
//
// `A{5}&A{6}` spent the whole million-step budget — about 950ms locally, and
// tens of megabytes fetched over a range-mode index — establishing that
// nothing is both five letters and six. The page then offered "Try harder".
// The automaton settles it in about forty states, because emptiness is a
// question about reachable DFA states rather than about words.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { compileConjuncts, compileQuery } from "../src/find-expr.js";
import {
  EMPTINESS_BUDGET,
  conflictText,
  conflictingConjuncts,
  languageEmptiness,
} from "../src/emptiness.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();
const verdict = (q: string) => languageEmptiness(compileQuery(q, ctx));

describe("patterns that match nothing", () => {
  it("catches two lengths that cannot both hold", () => {
    expect(verdict("A{5}&A{6}")).toBe("empty");
  });

  it("catches two different literals", () => {
    expect(verdict("cat&dog")).toBe("empty");
  });

  it("catches a pattern intersected with its own negation", () => {
    expect(verdict("A{5}&!A{5}")).toBe("empty");
  });

  it("catches a conflict that takes three parts to make", () => {
    // No letter is both a consonant and a vowel, so this needs all three
    // conjuncts to be contradictory — the emptiness answer still holds even
    // though no *pair* of them conflicts.
    expect(verdict("A{5}&C{5}&V{5}")).toBe("empty");
  });

  it("catches two value constraints that disagree", () => {
    expect(verdict("{sum=52:A*}&{sum=99:A*}")).toBe("empty");
  });
});

describe("patterns that do match", () => {
  it("says so, immediately, for ordinary queries", () => {
    for (const q of ["A{5}", "solar s_stem", "A{4} A{5}", "{list:greek}"]) {
      expect(verdict(q), q).toBe("matches");
    }
  });

  it("gives up on an anagram rather than proving the obvious", () => {
    // An 11-letter anagram accepts nothing until all 11 letters are in, so
    // reaching an accepting state costs more states than the budget allows.
    // "unknown" is the right answer: it falls through to the search, which
    // was always going to find these quickly.
    expect(verdict("<aciimnrttu>")).toBe("unknown");
  });

  it("is not fooled by a match that only appears at depth", () => {
    // Nothing accepts until the twentieth letter. The walk is over states,
    // not over strings, so this is twenty-odd states rather than 37^20.
    expect(verdict("A{20}")).toBe("matches");
  });
});

describe("the budget", () => {
  it("gives up rather than guessing on a large automaton", () => {
    expect(languageEmptiness(compileQuery("{distinct:A{6}}", ctx), 500)).toBe(
      "unknown",
    );
  });

  it("never calls a matching pattern empty, at any budget", () => {
    // The safety property the whole feature rests on: a wrong "empty" hides
    // real results, where "unknown" costs only what the search already cost.
    // Running out must therefore never *conclude* anything.
    const matching = ["A{5}", "solar s_stem", "<aciimnrttu>", "{distinct:A{6}}"];
    for (const budget of [1, 2, 37, 500, 5000]) {
      for (const q of matching) {
        expect(
          languageEmptiness(compileQuery(q, ctx), budget),
          `${q} @ ${budget}`,
        ).not.toBe("empty");
      }
    }
  });

  it("still proves emptiness when the automaton dies at the start", () => {
    // `cat&dog` disagrees on the first letter, so the start state has no
    // transitions at all and one state is enough. Not a guess: nothing was
    // left unexplored.
    expect(languageEmptiness(compileQuery("cat&dog", ctx), 1)).toBe("empty");
  });

  it("is small because proofs are cheap, not because automata are", () => {
    // Every contradiction above is provable well inside the budget; raising
    // it would only make ordinary searches pre-build states they never visit.
    expect(EMPTINESS_BUDGET).toBeLessThanOrEqual(5000);
    expect(languageEmptiness(compileQuery("A{5}&A{6}", ctx), 100)).toBe("empty");
  });
});

describe("naming the parts that disagree", () => {
  it("names the two conjuncts a reader wrote", () => {
    expect(conflictText("A{5}&A{6}", ctx)).toEqual(["A{5}", "A{6}"]);
    expect(conflictText("cat&dog", ctx)).toEqual(["cat", "dog"]);
  });

  it("prefers the smaller explanation: one empty part over a pair", () => {
    // `(cat&dog)` is contradictory inside a group, so it materializes to an
    // empty NFA and arrives as a single conjunct that matches nothing on its
    // own. Reporting it alongside an innocent bystander would be worse than
    // reporting it alone.
    const alone = compileConjuncts("(cat&dog)x", ctx);
    expect(conflictingConjuncts(alone)).toEqual([0]);
    // Where it really does take two, both are named.
    expect(conflictingConjuncts(compileConjuncts("cat&dog", ctx))).toEqual([
      0, 1,
    ]);
  });

  it("names constructs, which are several conjuncts written as one", () => {
    // This used to be the case that could not be named: `{sum=52:A*}` is four
    // conjuncts, so pairing compiled conjuncts with written ones by position
    // went wrong the moment a construct appeared — which is most real
    // queries. Each written part is compiled on its own now, so the two stay
    // aligned by construction.
    expect(conflictText("{sum=52:A*}&{sum=99:A*}", ctx)).toEqual([
      "{sum=52:A*}",
      "{sum=99:A*}",
    ]);
    // A letter bank is one per distinct letter — nine of them here — so a
    // five-letter match cannot carry them all.
    expect(conflictText("{bank:washington}&A{5}", ctx)).toEqual([
      "{bank:washington}",
      "A{5}",
    ]);
    expect(conflictText("{list:greek}&A{20}", ctx)).toEqual([
      "{list:greek}",
      "A{20}",
    ]);
  });

  it("says nothing when a part cannot stand on its own", () => {
    // Splitting on `&` is a guess at the writer's parts; when a piece does not
    // compile alone there is nothing honest to name.
    expect(conflictText("A{5}", ctx)).toBeNull();
  });

  it("declines to name a conflict that needs three parts", () => {
    expect(conflictText("A{5}&C{5}&V{5}", ctx)).not.toEqual([]);
  });
});

describe("the session", () => {
  const data = fs.readFileSync("web/public/demo.index");

  it("reports it without walking the index at all", async () => {
    const reader = await IndexReader.open(new MemorySource(data));
    const session = new SearchSession(reader, "A{5}&A{6}", ctx);
    const out: string[] = [];
    const status = await session.run(1e6, 100, (r) => out.push(r.text));
    expect(status).toBe("empty");
    expect(out).toEqual([]);
    // The point of the whole exercise: no steps were spent proving it.
    expect(session.steps).toBe(0);
  });

  it("still searches normally when the pattern can match", async () => {
    const reader = await IndexReader.open(new MemorySource(data));
    const session = new SearchSession(reader, "A{5}", ctx);
    const out: string[] = [];
    const status = await session.run(1e6, 5, (r) => out.push(r.text));
    expect(status).toBe("results");
    expect(out.length).toBe(5);
  });

  it("answers again immediately when asked to try harder", async () => {
    const reader = await IndexReader.open(new MemorySource(data));
    const session = new SearchSession(reader, "cat&dog", ctx);
    expect(await session.run(1e6, 100, () => {})).toBe("empty");
    expect(await session.run(1e9, 100, () => {})).toBe("empty");
    expect(session.steps).toBe(0);
  });
});
