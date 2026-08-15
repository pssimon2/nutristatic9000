import { describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { ExprFilter } from "../src/expr-filter.js";
import { parseExpr } from "../src/expr-parse.js";
import {
  A1Z26,
  SCRABBLE,
  parseValueRange,
  valueNfa,
} from "../src/value-constraint.js";

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

function compile(pattern: string): Nfa {
  const nfa = new Nfa();
  const end = parseExpr(pattern, 0, nfa, false);
  expect(end).toBe(pattern.length);
  return nfa;
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
    const nfa = valueNfa(A1Z26, { lo: 52, hi: 52 });
    expect(a1z26("shall")).toBe(52);
    expect(accepts(nfa, "shall")).toBe(true);
    expect(accepts(nfa, "well")).toBe(true); // 23+5+12+12
    expect(accepts(nfa, "the")).toBe(false); // 33
  });

  it("ignores spaces and digits, so phrases total by letter", () => {
    const nfa = valueNfa(A1Z26, { lo: 52, hi: 52 });
    expect(accepts(nfa, "a full")).toBe(true); // 1+6+21+12+12
    expect(accepts(nfa, "we are")).toBe(true); // w+e+a+r+e, spaces free
    expect(accepts(nfa, "we are1")).toBe(true); // digits count zero too
  });

  it("handles open upper bounds by saturating", () => {
    const nfa = valueNfa(A1Z26, { lo: 200, hi: Infinity });
    expect(a1z26("transportation")).toBe(200);
    expect(accepts(nfa, "transportation")).toBe(true);
    expect(accepts(nfa, "transportations")).toBe(true); // still >= 200
    expect(accepts(nfa, "the")).toBe(false);
  });

  it("scores Scrabble tiles", () => {
    const nfa = valueNfa(SCRABBLE, { lo: 26, hi: Infinity });
    expect(accepts(nfa, "fuzzy")).toBe(true); // 4+1+10+10+4 = 29
    expect(accepts(nfa, "eerie")).toBe(false); // 1+1+1+1+1 = 5
  });
});

describe("{sum:…} in patterns", () => {
  it("intersects the constraint with the pattern", () => {
    const nfa = compile("{sum=52:A*}");
    expect(accepts(nfa, "shall")).toBe(true);
    expect(accepts(nfa, "the")).toBe(false);
  });

  it("composes with other conjuncts", () => {
    const nfa = compile("{sum=52:A*}&A{4}");
    expect(accepts(nfa, "well")).toBe(true);
    expect(accepts(nfa, "shall")).toBe(false); // right total, wrong length
  });

  it("supports ranges and scrabble tables", () => {
    expect(accepts(compile("{sum=50..60:A{4}}"), "this")).toBe(true); // 56
    expect(accepts(compile("{sum=50..60:A{4}}"), "aaaa")).toBe(false); // 4
    expect(accepts(compile("{scrabble>25:A{5}}"), "fuzzy")).toBe(true);
  });

  it("rejects unknown names and malformed comparisons", () => {
    // The grammar allows an empty expression, so a bad construct shows up as
    // a short parse — exactly what the callers report as "can't parse".
    const nfa = new Nfa();
    for (const bad of ["{nosuch=1:A*}", "{sum=:A*}", "{sum~5:A*}"]) {
      expect(parseExpr(bad, 0, nfa, false)).not.toBe(bad.length);
    }
  });
});
