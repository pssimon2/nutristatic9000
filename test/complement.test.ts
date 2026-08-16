// Negation, walked lazily.
//
// `complement()` has to determinize before it can flip acceptance, and a
// conjunct like `{distinct:A{6}}` is 98,575 states — already deterministic,
// so nothing is exploding, it is simply big. Building its complement as an
// NFA cost about a gigabyte of arcs, of which a search visits a few thousand,
// and the 5,000-state cap that kept it from being attempted reported itself
// as `can't parse "!{distinct:A{6}}"` — which is not what went wrong, and
// sent people looking for a typo that was not there.
//
// `ComplementFilter` walks the complement as the search asks for it. The
// pivotal claim is that it accepts exactly what the eager complement accepts,
// so the first test here is a differential one against `complement()` on
// languages small enough to build both ways.

import { describe, expect, it } from "vitest";
import { ALPHABET, Nfa, complement } from "../src/automata.js";
import { ComplementFilter, ExprFilter, Filter } from "../src/expr-filter.js";
import { Box, parseExprBox } from "../src/expr-parse.js";
import { compileConjuncts, compileQuery } from "../src/find-expr.js";
import { isNegated } from "../src/conjunct.js";
import { ParseError } from "../src/parse-error.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

/** Parse a pattern to a single NFA, with no trailing space appended. */
function nfaOf(pattern: string): Nfa {
  const box = new Box();
  parseExprBox(pattern, 0, box, false, ctx);
  return box.materialize();
}

function accepts(filter: Filter, text: string): boolean {
  let state = filter.startState;
  for (const ch of text) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

/** Every string up to `len` over a small alphabet, the empty one included. */
function wordsUpTo(len: number, alphabet: string): string[] {
  let frontier = [""];
  const all = [""];
  for (let i = 0; i < len; ++i) {
    frontier = frontier.flatMap((w) => [...alphabet].map((c) => w + c));
    all.push(...frontier);
  }
  return all;
}

describe("the lazy complement agrees with the eager one", () => {
  // Both are built for these, so they can be compared word for word. If they
  // ever disagree, the lazy one is wrong: the eager path is the definition.
  const PATTERNS = [
    "a",
    "ab",
    "a*",
    "(a|b)c",
    ".*aa.*",
    "a?b",
    "<abc>",
    "A{2}",
    "{distinct:A{3}}",
    "a|bb|ccc",
  ];
  const WORDS = wordsUpTo(4, "abc ");

  for (const pattern of PATTERNS) {
    it(`accepts the same words as !(${pattern})`, () => {
      const inner = nfaOf(pattern);
      const eager = complement(inner, Number.MAX_SAFE_INTEGER);
      expect(eager).not.toBeNull();
      const eagerFilter = new ExprFilter(eager!);
      const lazy = new ComplementFilter(new ExprFilter(inner));

      const disagree = WORDS.filter(
        (w) => accepts(eagerFilter, w) !== accepts(lazy, w),
      );
      expect(disagree).toEqual([]);
    });
  }

  it("checks enough words to be worth believing", () => {
    expect(WORDS.length).toBe(341);
  });
});

describe("the sink", () => {
  it("accepts once the word has left the inner language, and stays there", () => {
    // "ab" leaves `a*` at the "b" and can never come back, so every extension
    // is in the complement too. The eager path reached this by completing the
    // transition table with a sink; the lazy one has no table to complete.
    const lazy = new ComplementFilter(new ExprFilter(nfaOf("a*")));
    expect(accepts(lazy, "b")).toBe(true);
    expect(accepts(lazy, "ba")).toBe(true);
    expect(accepts(lazy, "baaaa")).toBe(true);
    expect(accepts(lazy, "aaaa")).toBe(false);
  });

  it("does not swallow characters outside the alphabet", () => {
    // The language is over ALPHABET, so a character that is not in it has no
    // transition at all — the sink is for words the inner automaton rejects,
    // not for symbols the alphabet does not contain.
    const lazy = new ComplementFilter(new ExprFilter(nfaOf("a*")));
    expect(lazy.transition(lazy.startState, "%".charCodeAt(0))).toBe(-1);
  });
});

describe("negating something too big to build out", () => {
  // The case that motivated all of this. `{distinct:A{6}}` is 98,575 states;
  // its complement was never attempted, and the refusal claimed to be a
  // syntax error.
  it("compiles as a conjunct of its own", () => {
    expect(() => compileQuery("!{distinct:A{6}}", ctx)).not.toThrow();
  });

  it("compiles inside an intersection", () => {
    expect(() => compileQuery("A{6}&!{distinct:A{6}}", ctx)).not.toThrow();
  });

  it("finds words with a repeated letter, and only those", () => {
    const filter = compileQuery("A{6}&!{distinct:A{6}}", ctx);
    for (const w of ["people", "school", "delete", "season"]) {
      expect(accepts(filter, `${w} `)).toBe(true);
    }
    for (const w of ["blacks", "wisdom", "thumbs"]) {
      expect(accepts(filter, `${w} `)).toBe(false);
    }
  });

  it("stays lazy: the complement is never materialized", () => {
    // A materialized complement would be ~98,576 states before the search
    // starts. The lazy one begins with the handful the start state closes
    // over, and grows only as the index walk asks it to.
    const filter = compileQuery("!{distinct:A{6}}", ctx);
    expect(filter.stateCount).toBeLessThan(1000);
  });
});

describe("the trailing space a negated conjunct carries", () => {
  // Appending the required space inside a negation is only sound for words
  // that end in one, because ¬A·" " and ¬(A·" ") part company exactly on the
  // words that do not. A query whose conjuncts are *all* negated has nothing
  // else forcing the space, so compileConjuncts adds it as its own conjunct.
  it("adds the ends-in-a-space conjunct when every conjunct is negated", () => {
    const cs = compileConjuncts("!.*ee.*", ctx);
    expect(cs.length).toBe(2);
    expect(cs.filter(isNegated).length).toBe(1);
  });

  it("does not add it when a positive conjunct already forces it", () => {
    const cs = compileConjuncts("A{5}&!.*ee.*", ctx);
    expect(cs.length).toBe(2);
    expect(cs.every(isNegated)).toBe(false);
  });

  it("rejects a match that stops short of the word boundary", () => {
    // Without the guard the lone negation would accept "th" as readily as
    // "the ", and the search would emit prefixes as if they were words.
    const filter = compileQuery("!{distinct:A{5}}", ctx);
    expect(accepts(filter, "the ")).toBe(true);
    expect(accepts(filter, "the")).toBe(false);
  });
});

describe("when the complement really must be built out", () => {
  // Inside a quantifier, a union or a concatenation there is no filter to be
  // lazy in: an NFA is structurally required, so the eager path runs and can
  // still hit its limit. What it must not do is call that a syntax error.
  const TOO_BIG = "(!{distinct:A{6}})*";

  it("names the limit instead of blaming the syntax", () => {
    expect(() => compileQuery(TOO_BIG, ctx)).toThrow(ParseError);
    try {
      compileQuery(TOO_BIG, ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      const message = (e as ParseError).message;
      expect(message).not.toMatch(/can't parse/);
      expect(message).toMatch(/5000-state limit/);
      // And it says what does work, since the same negation is fine alone.
      expect(message).toMatch(/&/);
    }
  });

  it("still builds out the small complements it always could", () => {
    expect(() => compileQuery("(!.*ee.*)*", ctx)).not.toThrow();
  });
});

describe("the alphabet the sink loops on", () => {
  it("covers every symbol the parser can produce", () => {
    // A symbol missing from ALPHABET would be one the sink cannot loop on,
    // and a word containing it would drop out of the complement.
    const lazy = new ComplementFilter(new ExprFilter(nfaOf("zzzz")));
    for (const ch of ALPHABET) {
      expect(lazy.transition(lazy.startState, ch)).not.toBe(-1);
    }
  });
});
