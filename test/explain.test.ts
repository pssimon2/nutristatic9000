// Reconstructing why a match matched. The value is entirely in naming the
// thing the engine discarded: that CLOCK came from the bird COCK plus an L is
// the answer to "why is this here", and the search itself never knew it.

import { describe, expect, it } from "vitest";
import { explainMatch, topLevelConjuncts } from "../src/explain.js";
import { SessionContext } from "../src/session-context.js";
import { parsePhonetics } from "../src/phonetics.js";

const ctx = new SessionContext();
ctx.phonetics = parsePhonetics("R tree free\n");

/** The detail for the conjunct at `i`, or null. */
function detail(pattern: string, text: string, i = 0): string | null {
  return explainMatch(pattern, text, ctx)[i].detail;
}

describe("topLevelConjuncts", () => {
  it("splits on & between conjuncts", () => {
    expect(topLevelConjuncts("A{5}&C*")).toEqual(["A{5}", "C*"]);
  });

  it("leaves an & alone inside a construct, class or quoted run", () => {
    expect(topLevelConjuncts("{list:a&b}")).toEqual(["{list:a&b}"]);
    expect(topLevelConjuncts("[a&b]x")).toEqual(["[a&b]x"]);
    expect(topLevelConjuncts('"a&b"')).toEqual(['"a&b"']);
    expect(topLevelConjuncts("<ab&>")).toEqual(["<ab&>"]);
  });

  it("handles nesting and stray whitespace", () => {
    expect(topLevelConjuncts("{del1:{list:greek}} & A{4}")).toEqual([
      "{del1:{list:greek}}",
      "A{4}",
    ]);
  });
});

describe("explaining each conjunct", () => {
  it("reports every conjunct, satisfied or not", () => {
    const rs = explainMatch("A{5}&C*", "shall", ctx);
    expect(rs.map((r) => r.part)).toEqual(["A{5}", "C*"]);
    expect(rs[0].ok).toBe(true);
    expect(rs[1].ok).toBe(false); // "shall" is not all consonants
  });

  it("says nothing extra when the pattern speaks for itself", () => {
    expect(detail("A{5}", "shall")).toBeNull();
  });
});

describe("naming the source of an edit", () => {
  it("names the word and the added letter", () => {
    expect(detail("{add1:{list:greek}}", "alphax")).toBe(
      "“alpha” with “x” added",
    );
  });

  it("names the word and the removed letter", () => {
    expect(detail("{del1:{list:greek}}", "alpa")).toBe(
      "“alpha” with the “h” removed",
    );
  });

  it("names both letters of a substitution", () => {
    expect(detail("{subst1:{list:greek}}", "alpho")).toBe(
      "“alpha” with “a” swapped for “o”",
    );
  });

  it("works through a nested category, which is the case that needed it", () => {
    // The engine returns "alpa" with no hint which Greek letter it came from.
    const d = detail("{del1:{list:greek}}", "gama");
    expect(d).toBe("“gamma” with the “m” removed");
  });
});

describe("naming a cipher shift", () => {
  it("reports the shift that decodes the literal", () => {
    expect(detail("{caesar:kdhv}", "pima")).toBe("“kdhv” shifted by 5");
    expect(detail("{rot13:uryyb}", "hello")).toBe("“uryyb” shifted by 13");
  });
});

describe("naming a computed value", () => {
  it("gives the total the constraint was testing", () => {
    expect(detail("{sum=52:A*}", "shall")).toBe("letters total 52");
    expect(detail("{letters=5:A*}", "shall")).toBe("5 letters");
    expect(detail("{words=2:A*}", "of the")).toBe("2 words");
  });

  it("explains an occurrence constraint", () => {
    expect(detail("{count(l)=2:A*}", "shall")).toBe("2 of those letters");
    expect(detail("{distinct:A{5}}", "learn")).toBe("no letter repeats");
  });
});

describe("naming a lookup", () => {
  it("says which category or list the match belongs to", () => {
    expect(detail("{list:greek}", "alpha")).toBe("“alpha” is in the greek list");
    expect(detail("{rhyme:tree}", "free")).toBe("“free” rhymes with tree");
  });
});

describe("robustness", () => {
  it("does not throw on a conjunct it cannot compile", () => {
    const rs = explainMatch("{nosuch:x}&A{5}", "shall", ctx);
    expect(rs[0].ok).toBe(false);
    expect(rs[1].ok).toBe(true);
  });

  it("reports a conjunct the match fails, with no invented detail", () => {
    const rs = explainMatch("{list:greek}", "zzz", ctx);
    expect(rs[0].ok).toBe(false);
    expect(rs[0].detail).toBeNull();
  });
});
