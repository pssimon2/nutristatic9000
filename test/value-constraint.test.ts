import { describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { ExprFilter } from "../src/expr-filter.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import {
  A1Z26,
  MAX_COUNTER_STATES,
  SCRABBLE,
  editNfaOver,
  parseValueRange,
  valueNfa,
} from "../src/value-constraint.js";
import { SessionContext } from "../src/session-context.js";
import { entriesNfa } from "../src/word-lists.js";

const ctx = new SessionContext();

/** Run `text` through the automaton and report acceptance. */
function accepts(nfa: Nfa, text: string): boolean {
  const filter = new ExprFilter(nfa);
  let state = filter.startState;
  for (const ch of text) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

/**
 * Match through the engine's own compiled filter — lazy, so multi-conjunct
 * constraints like {distinct} never materialise a product eagerly. Matches
 * carry the trailing space compileQuery requires.
 */
function matches(pattern: string, text: string): boolean {
  const filter = compileQuery(pattern, ctx);
  let state = filter.startState;
  for (const ch of `${text} `) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

/** Rejected either by throwing an explanation or by failing to parse. */
function rejects(pattern: string): void {
  const nfa = new Nfa();
  let end: number | null = null;
  try {
    end = parseExpr(pattern, 0, nfa, false, ctx);
  } catch {
    return;
  }
  expect(end).not.toBe(pattern.length);
}

const a1z26 = (s: string) =>
  [...s].reduce((n, c) => n + (A1Z26[c.charCodeAt(0)] ?? 0), 0);

describe("parseValueRange", () => {
  it("reads every comparison form", () => {
    expect(parseValueRange("=100")).toEqual({ lo: 100, hi: 100 });
    expect(parseValueRange("<30")).toEqual({ lo: 0, hi: 29 });
    expect(parseValueRange("<=30")).toEqual({ lo: 0, hi: 30 });
    expect(parseValueRange(">25")).toEqual({ lo: 26, hi: Infinity });
    expect(parseValueRange(">=25")).toEqual({ lo: 25, hi: Infinity });
    expect(parseValueRange("50..60")).toEqual({ lo: 50, hi: 60 });
    expect(parseValueRange("=50..60")).toEqual({ lo: 50, hi: 60 });
  });

  it("rejects nonsense and empty ranges", () => {
    expect(parseValueRange("")).toBeNull();
    expect(parseValueRange("~5")).toBeNull();
    expect(parseValueRange("=x")).toBeNull();
    expect(parseValueRange("60..50")).toBeNull();
    expect(parseValueRange("<0")).toBeNull(); // nothing sums below zero
  });
});

describe("valueNfa", () => {
  it("accepts exactly the totals in range", () => {
    const nfa = valueNfa(A1Z26, { lo: 52, hi: 52 })!;
    expect(a1z26("shall")).toBe(52);
    expect(accepts(nfa, "shall")).toBe(true);
    expect(accepts(nfa, "well")).toBe(true); // 23+5+12+12
    expect(accepts(nfa, "the")).toBe(false); // 33
  });

  it("ignores spaces and digits, so phrases total by letter", () => {
    const nfa = valueNfa(A1Z26, { lo: 52, hi: 52 })!;
    expect(accepts(nfa, "a full")).toBe(true); // 1+6+21+12+12
    expect(accepts(nfa, "we are")).toBe(true); // w+e+a+r+e, spaces free
    expect(accepts(nfa, "we are1")).toBe(true); // digits count zero too
  });

  it("handles open upper bounds by saturating", () => {
    const nfa = valueNfa(A1Z26, { lo: 200, hi: Infinity })!;
    expect(a1z26("transportation")).toBe(200);
    expect(accepts(nfa, "transportation")).toBe(true);
    expect(accepts(nfa, "transportations")).toBe(true); // still >= 200
    expect(accepts(nfa, "the")).toBe(false);
  });

  it("scores Scrabble tiles", () => {
    const nfa = valueNfa(SCRABBLE, { lo: 26, hi: Infinity })!;
    expect(accepts(nfa, "fuzzy")).toBe(true); // 4+1+10+10+4 = 29
    expect(accepts(nfa, "eerie")).toBe(false); // 1+1+1+1+1 = 5
  });
});

describe("{sum:…} in patterns", () => {
  it("intersects the constraint with the pattern", () => {
    expect(matches("{sum=52:A*}", "shall")).toBe(true);
    expect(matches("{sum=52:A*}", "the")).toBe(false);
  });

  it("composes with other conjuncts", () => {
    expect(matches("{sum=52:A*}&A{4}", "well")).toBe(true);
    expect(matches("{sum=52:A*}&A{4}", "shall")).toBe(false); // wrong length
  });

  it("supports ranges and scrabble tables", () => {
    expect(matches("{sum=50..60:A{4}}", "this")).toBe(true); // 56
    expect(matches("{sum=50..60:A{4}}", "aaaa")).toBe(false); // 4
    expect(matches("{scrabble>25:A{5}}", "fuzzy")).toBe(true);
  });

  it("rejects unknown names and malformed comparisons", () => {
    // The grammar allows an empty expression, so a bad construct shows up as
    // a short parse — exactly what the callers report as "can't parse".
    for (const bad of ["{nosuch=1:A*}", "{sum=:A*}", "{sum~5:A*}"]) rejects(bad);
  });
});

describe("occurrence and multiset constraints", () => {
  it("counts a letter", () => {
    expect(matches("{count(e)=2:A*}", "free")).toBe(true);
    expect(matches("{count(e)=2:A*}", "the")).toBe(false);
  });

  it("counts a named class", () => {
    expect(matches("{count(vowel)<=1:A{5}}", "which")).toBe(true);
    expect(matches("{count(vowel)<=1:A{5}}", "audio")).toBe(false);
    // y counts as a consonant, matching the engine's C class.
    expect(matches("{count(consonant)=6:A*}", "rhythm")).toBe(true);
    expect(matches("{count(consonant)=5:A*}", "rhythm")).toBe(false);
  });

  it("requires every letter of a set", () => {
    expect(matches("{all(aeiou):A*}", "education")).toBe(true);
    expect(matches("{all(aeiou):A*}", "the")).toBe(false);
  });

  it("forbids repeats, as 26 small counters rather than one subset machine", () => {
    expect(matches("{distinct:A{6}}", "search")).toBe(true);
    expect(matches("{distinct:A{6}}", "letter")).toBe(false);
    expect(matches("{maxrep=2:A*}", "letter")).toBe(true); // two e's, two t's
    expect(matches("{maxrep=1:A*}", "letter")).toBe(false);
  });

  it("counts letters and words", () => {
    expect(matches("{letters=11:A*}", "information")).toBe(true);
    expect(matches("{letters=11:A*}", "info")).toBe(false);
    // Letters ignore spaces; words count them.
    expect(matches("{letters=5:A*}", "of the")).toBe(true);
    expect(matches("{words=2:A*}", "of the")).toBe(true);
    expect(matches("{words=1:A*}", "of the")).toBe(false);
    expect(matches("{words=1:A*}", "the")).toBe(true);
  });

  it("rejects malformed specs", () => {
    for (const bad of [
      "{count=2:A*}",
      "{count():A*}",
      "{distinct=3:A*}",
      "{all:A*}",
      "{words=0:A*}",
      "{maxrep>=2:A*}",
    ]) {
      rejects(bad);
    }
  });
});

describe("letter banks and sub-anagrams", () => {
  it("sub-anagrams respect multiplicities and the alphabet", () => {
    expect(matches("{sub:cryptography}", "crypt")).toBe(true);
    expect(matches("{sub:cryptography}", "cot")).toBe(true);
    expect(matches("{sub:cryptography}", "ccc")).toBe(false); // one c available
    expect(matches("{sub:cryptography}", "zebra")).toBe(false); // z not in bank
  });

  it("banks demand every distinct letter but allow repeats", () => {
    expect(matches("<<washington>>", "washington")).toBe(true);
    expect(matches("<<washington>>", "was nothing")).toBe(true);
    expect(matches("<<washington>>", "was")).toBe(false); // missing letters
    expect(matches("<<washington>>", "washingtonn")).toBe(true); // repeats fine
    expect(matches("{bank:aelpp}", "apple")).toBe(true);
    expect(matches("{bank:aelpp}", "app")).toBe(false); // no l or e
  });

  it("rejects empty or non-letter banks", () => {
    for (const bad of ["{sub:}", "{bank:12}", "<<>>"]) rejects(bad);
  });
});

describe("edit-distance operators", () => {
  it("deletes exactly one letter", () => {
    for (const w of ["best", "east", "beat", "bast", "beas"]) {
      expect(matches("{del1:beast}", w)).toBe(true);
    }
    expect(matches("{del1:beast}", "beast")).toBe(false); // no edit spent
    expect(matches("{del1:beast}", "bes")).toBe(false); // two deletions
  });

  it("adds and substitutes", () => {
    expect(matches("{add1:cargo}", "cargos")).toBe(true);
    expect(matches("{add1:cargo}", "cargo")).toBe(false);
    expect(matches("{subst1:cargo}", "fargo")).toBe(true);
    expect(matches("{subst1:cargo}", "cargo")).toBe(false);
    // Each operator does only its own kind of edit.
    expect(matches("{del1:cargo}", "fargo")).toBe(false);
    expect(matches("{add1:cargo}", "fargo")).toBe(false);
  });

  it("mixes edits up to a bound", () => {
    expect(matches("{edit<=1:cargo}", "cargo")).toBe(true); // zero edits allowed
    expect(matches("{edit<=1:cargo}", "fargo")).toBe(true);
    expect(matches("{edit<=1:cargo}", "argo")).toBe(true);
    expect(matches("{edit<=2:cargo}", "farg")).toBe(true); // sub + del
    expect(matches("{edit<=1:cargo}", "farg")).toBe(false);
  });

  it("does not edit across spaces", () => {
    // Inserting a space would turn one word into two; edits stay letters.
    expect(matches("{add1:cargo}", "car go")).toBe(false);
  });

  it("rejects unusable words and bounds", () => {
    for (const bad of ["{del1:}", "{del0:cargo}", "{edit<=9:cargo}", "{del1:ab!}"]) rejects(bad);
  });
});

describe("edits over an inner pattern", () => {
  // The Levenshtein construction works over any inner automaton, not just a
  // literal chain, so an edit can wrap a whole set: "one letter off *some*
  // Greek letter" rather than one letter off a word you had to name.

  it("deletes a letter from any member of the set", () => {
    expect(matches("{del1:{list:greek}}", "alpa")).toBe(true); // alpha
    expect(matches("{del1:{list:greek}}", "delt")).toBe(true); // delta
    expect(matches("{del1:{list:greek}}", "gama")).toBe(true); // gamma
  });

  it("still demands exactly the edits asked for", () => {
    // The unedited member is not an answer to "one letter off".
    expect(matches("{del1:{list:greek}}", "alpha")).toBe(false);
    expect(matches("{subst1:{list:greek}}", "alpha")).toBe(false);
    // …but a <= range includes spending none.
    expect(matches("{edit<=1:{list:greek}}", "alpha")).toBe(true);
    expect(matches("{edit<=1:{list:greek}}", "alpa")).toBe(true);
  });

  it("substitutes and inserts over the set", () => {
    expect(matches("{subst1:{list:greek}}", "alpho")).toBe(true);
    expect(matches("{add1:{list:greek}}", "alphax")).toBe(true);
  });

  it("matches nothing outside the set's neighbourhood", () => {
    expect(matches("{del1:{list:greek}}", "zzzz")).toBe(false);
    expect(matches("{del1:{list:greek}}", "alp")).toBe(false); // two deletions
  });

  it("composes with the rest of the language", () => {
    expect(matches("{del1:{list:greek}}&A{4}", "delt")).toBe(true);
    expect(matches("{del1:{list:greek}}&A{5}", "delt")).toBe(false);
  });

  it("reads a bare argument as an exact word, not a space-skipping pattern", () => {
    // Unquoted patterns allow spaces between letters; the edit argument must
    // not, or {del1:beast} would quietly also mean {del1:"be ast"}.
    expect(matches("{del1:beast}", "best")).toBe(true);
    expect(matches("{del1:beast}", "b est")).toBe(false);
  });

  it("takes deletion over a big set but refuses substitution over it", () => {
    // Deletion adds one epsilon per arc; substitution and insertion fan out
    // across the editable alphabet, so they cost ~36x. A set the size of a
    // WordNet category is fine for {del…} and far too large for {subst…},
    // which must be refused with an explanation rather than allocating
    // millions of arcs. Built directly here so the check does not depend on
    // the category data being loaded.
    const words = Array.from({ length: 2000 }, (_, i) =>
      `w${i.toString(36).padStart(4, "0")}`,
    );
    const set = entriesNfa(words)!;
    expect(set).not.toBeNull();
    const one = { lo: 1, hi: 1 };
    expect(editNfaOver(set, { del: true, add: false, subst: false }, one)).not.toBeNull();
    expect(editNfaOver(set, { del: false, add: false, subst: true }, one)).toBeNull();
    expect(editNfaOver(set, { del: false, add: true, subst: false }, one)).toBeNull();
  });

  it("has nothing to edit in an empty argument", () => {
    expect(editNfaOver(entriesNfa([""])!, { del: true, add: false, subst: false }, { lo: 1, hi: 1 })).toBeNull();
  });
});

describe("cipher transforms", () => {
  it("tries every shift when the shift is unknown", () => {
    expect(matches("{caesar:kdhv}", "pima")).toBe(true); // +5
    expect(matches("{caesar:kdhv}", "haes")).toBe(true); // +23
    expect(matches("{caesar:kdhv}", "kdhv")).toBe(false); // identity excluded
    expect(matches("{caesar:kdhv}", "pimb")).toBe(false); // inconsistent shift
  });

  it("applies a known shift", () => {
    expect(matches("{rot13:cvmmn}", "pizza")).toBe(true);
    expect(matches("{caesar+3:zoo}", "crr")).toBe(true);
    expect(matches("{caesar+3:zoo}", "zoo")).toBe(false);
  });

  it("reflects the alphabet for atbash", () => {
    expect(matches("{atbash:gsv}", "the")).toBe(true);
    expect(matches("{atbash:gsv}", "gsv")).toBe(false);
  });

  it("rejects non-literal or malformed arguments", () => {
    for (const bad of ["{caesar:}", "{caesar:a1}", "{rot:abc}", "{atbash=1:gsv}"]) rejects(bad);
  });
});

describe("structural classes and encodings", () => {
  it("restricts to letter sets", () => {
    expect(matches("{roman:A*}", "civic")).toBe(true);
    expect(matches("{roman:A*}", "cat")).toBe(false);
    // This is the letter set that survives a turn (HINOSXZ), not full
    // ambigram detection: SWIMS reads as itself only because W and M rotate
    // into each other, which needs the reversal a regular language can't do.
    expect(matches("{rot180:A*}", "onion")).toBe(true);
    expect(matches("{rot180:A*}", "noon")).toBe(true);
    expect(matches("{rot180:A*}", "swims")).toBe(false);
    expect(matches("{rot180:A*}", "cat")).toBe(false);
    expect(matches("{row1:A*}", "typewriter")).toBe(true);
    expect(matches("{row1:A*}", "typewriters")).toBe(false); // s is row 2
    expect(matches("{holes=0:A*}", "system")).toBe(true);
    expect(matches("{holes=0:A*}", "apple")).toBe(false);
  });

  it("orders letters", () => {
    expect(matches("{ascending:A*}", "almost")).toBe(true);
    expect(matches("{ascending:A*}", "billowy")).toBe(true);
    expect(matches("{ascending:A*}", "cat")).toBe(false);
    expect(matches("{descending:A*}", "spoonfed")).toBe(true);
    expect(matches("{descending:A*}", "cat")).toBe(false);
  });

  it("decodes T9 keypresses to every consistent spelling", () => {
    for (const w of ["book", "cool", "cook", "bonk"]) {
      expect(matches("{t9:2665}", w)).toBe(true);
    }
    expect(matches("{t9:2665}", "boot")).toBe(false);
    expect(matches("{t9:2665}", "boo")).toBe(false);
  });

  it("matches crossword enumerations", () => {
    expect(matches("{enum:4,3,5}", "that the first")).toBe(true);
    expect(matches("{enum:4,3,5}", "that the firsts")).toBe(false);
    expect(matches("{enum:5}", "solar")).toBe(true);
  });

  it("rejects unknown classes and malformed arguments", () => {
    for (const bad of ["{roman=2:A*}", "{row9:A*}", "{t9:2601}", "{enum:x}", "{holes=7:A*}"]) rejects(bad);
  });
});

describe("complement", () => {
  it("negates a whole factor", () => {
    expect(matches("A{5}&!.*ee.*", "about")).toBe(true);
    expect(matches("A{5}&!.*ee.*", "green")).toBe(false);
    expect(matches("!.*e.*&A{4}", "that")).toBe(true);
    expect(matches("!.*e.*&A{4}", "them")).toBe(false);
  });

  it("negates character classes", () => {
    expect(matches("A{4}&!.*[aeiou].*", "html")).toBe(true);
    expect(matches("A{4}&!.*[aeiou].*", "that")).toBe(false);
  });

  it("is an involution on simple languages", () => {
    expect(matches("!!A{3}", "cat")).toBe(true);
    expect(matches("!!A{3}", "cats")).toBe(false);
  });

  it("rejects an empty or oversized negation", () => {
    rejects("!");
  });
});

describe("morse and element spelling", () => {
  it("resolves unspaced morse into every letter-splitting", () => {
    // ".." + ".-.." + "." and "...-" + "..." are both "...-..."
    expect(matches("{morse:...-...}", "ile")).toBe(true);
    expect(matches("{morse:...-...}", "vs")).toBe(true);
    expect(matches("{morse:...-...}", "cat")).toBe(false);
    // "...." ".-" "-." "-.."
    expect(matches("{morse:.....--.-..}", "hand")).toBe(true);
  });

  it("rejects morse that isn't dots and dashes", () => {
    for (const bad of ["{morse:abc}", "{morse:}"]) rejects(bad);
  });

  it("spells words in chemical symbols", () => {
    expect(matches("{elements:A*}", "bacon")).toBe(true); // Ba C O N
    expect(matches("{elements:A*}", "silicon")).toBe(true); // Si Li Co N
    expect(matches("{elements:A*}", "health")).toBe(true); // He Al Th
    expect(matches("{elements:A*}", "jazz")).toBe(false); // no J symbol
  });

  it("knows all 118 symbols", async () => {
    const { elementSymbolCount } = await import("../src/value-constraint.js");
    expect(elementSymbolCount()).toBe(118);
  });
});

describe("error messages", () => {
  it("names an unknown constraint and suggests the real one", () => {
    const nfa = new Nfa();
    expect(() => parseExpr("{sumx=100:A*}", 0, nfa, false, ctx)).toThrow(
      /no such constraint "sumx".*did you mean "sum"/,
    );
    expect(() => parseExpr("{distinkt:A{6}}", 0, nfa, false, ctx)).toThrow(
      /did you mean "distinct"/,
    );
  });

  it("says what a known constraint didn't understand", () => {
    const nfa = new Nfa();
    expect(() => parseExpr("{sum=abc:A*}", 0, nfa, false, ctx)).toThrow(
      /"sum" doesn't understand "=abc"/,
    );
  });

  it("offers no suggestion when nothing is close", () => {
    const nfa = new Nfa();
    expect(() => parseExpr("{zzzzzzzz:A*}", 0, nfa, false, ctx)).toThrow(
      /no such constraint "zzzzzzzz"$/,
    );
  });
});

describe("resource limits", () => {
  it("refuses a counter big enough to hurt", () => {
    // One state per total: a million would be ~1.8 GB, enough to take a tab
    // down. The largest total any real match can reach is ~1040.
    expect(valueNfa(A1Z26, { lo: 1_000_000, hi: 1_000_000 })).toBeNull();
    expect(valueNfa(A1Z26, { lo: 0, hi: MAX_COUNTER_STATES })).toBeNull();
    expect(valueNfa(A1Z26, { lo: 1040, hi: 1040 })).not.toBeNull();
  });

  it("says so rather than failing obscurely", () => {
    const nfa = new Nfa();
    expect(() => parseExpr("{sum=1000000:A*}", 0, nfa, false, ctx)).toThrow(
      /bound 1000000 is too large/,
    );
    expect(() => parseExpr("{count(e)=99999:A*}", 0, nfa, false, ctx)).toThrow(
      /too large/,
    );
  });

  it("still allows every sensible bound", () => {
    expect(matches("{sum=52:A*}", "shall")).toBe(true);
    expect(matches("{letters=11:A*}", "information")).toBe(true);
  });
});

describe("length limits on expanded constructs", () => {
  it("bounds enumerations and morse the way quantifiers are bounded", () => {
    const nfa = new Nfa();
    const many = Array(5000).fill("9").join(",");
    expect(() => parseExpr(`{enum:${many}}`, 0, nfa, false, ctx)).toThrow(
      /letters in total/,
    );
    expect(() => parseExpr(`{morse:${".".repeat(20000)}}`, 0, nfa, false, ctx)).toThrow(
      /up to 255/,
    );
    // Ordinary ones are unaffected.
    expect(matches("{enum:4,3,5}", "that the first")).toBe(true);
    expect(matches("{morse:...-...}", "vs")).toBe(true);
  });
});
