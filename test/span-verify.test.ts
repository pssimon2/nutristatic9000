// Predicates at any depth, decided per match on the span their node covers.
//
// The search runs on hulls; the `where` result filter is what makes the hull's
// over-approximation honest, by parsing each finished match against the
// pattern exactly. These tests go through the same path the front ends use —
// parseFilterWrappers to get the specs, applyResultFilters to decide — so they
// exercise the compile, the AST and the verifier together.

import { describe, expect, it } from "vitest";
import { applyResultFilters } from "../src/result-predicate.js";
import { parseFilterWrappers } from "../src/result-filter.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

/** An index that knows exactly these words. */
const knows = (...words: string[]) => {
  const set = new Set(words);
  return (w: string) => set.has(w);
};
const knowsNothing = () => false;

/** The verdict the front ends would reach for `text` under `query`. */
async function verdict(
  query: string,
  text: string,
  isWord: (w: string) => boolean = knowsNothing,
) {
  const { specs } = parseFilterWrappers(query);
  expect(specs.length, `${query} should carry a nested predicate`).toBeGreaterThan(0);
  return applyResultFilters(specs, text, ctx, isWord);
}

describe("a predicate beside a neighbour holds of its own span", () => {
  it("checks the palindrome against the first word only", async () => {
    expect((await verdict("{palindrome:A{5}} A{4}", "level door")).keep).toBe(true);
    expect((await verdict("{palindrome:A{5}} A{4}", "medal door")).keep).toBe(false);
    // The right span, not just any span: the palindrome must cover the A{5}.
    expect((await verdict("A{4} {palindrome:A{5}}", "door level")).keep).toBe(true);
    expect((await verdict("A{4} {palindrome:A{5}}", "level door")).keep).toBe(false);
  });

  it("carries the nested predicate's annotation out", async () => {
    const v = await verdict("{reversible:A{4}} A{4}", "trap door", knows("part"));
    expect(v.keep).toBe(true);
    expect(v.notes).toContain("← part");
  });
});

describe("a predicate composes with every combinator", () => {
  it("intersects", async () => {
    expect((await verdict("A{5}&{palindrome:A*}", "level")).keep).toBe(true);
    expect((await verdict("A{5}&{palindrome:A*}", "medal")).keep).toBe(false);
  });

  it("alternates, and only the branch that matched is asked", async () => {
    const q = "({palindrome:A{4}}|door)";
    expect((await verdict(q, "abba")).keep).toBe(true);
    expect((await verdict(q, "door")).keep).toBe(true);
    expect((await verdict(q, "dork")).keep).toBe(false);
  });

  it("quantifies", async () => {
    const q = "{palindrome:A{3}}?door";
    expect((await verdict(q, "door")).keep).toBe(true);
    expect((await verdict(q, "anadoor")).keep).toBe(true);
    expect((await verdict(q, "abcdoor")).keep).toBe(false);
  });

  it("negates, exactly rather than by hull", async () => {
    // The hull of `!{palindrome:A*}` is everything — only the verifier
    // separates these two.
    const q = "!{palindrome:A*}";
    expect((await verdict(q, "medal")).keep).toBe(true);
    expect((await verdict(q, "level")).keep).toBe(false);
  });

  it("sits inside an anagram part", async () => {
    // One piece is a four-letter palindrome, the others d and e — in any
    // order.
    const q = "<{palindrome:A{4}}de>";
    expect((await verdict(q, "dabbae")).keep).toBe(true);
    expect((await verdict(q, "eabbad")).keep).toBe(true);
    expect((await verdict(q, "dabcae")).keep).toBe(false);
  });

  it("stacks under a different predicate at any depth", async () => {
    // Outer wrapper peeled as ever; inner nested beside a neighbour.
    const q = "{palindrome:{reversible:A{3}}tab}";
    // "bat tab": the reversible span is "bat" (its mirror "tab" is a word),
    // and the whole thing reads the same backwards.
    const v = await verdict(q, "bat tab", knows("tab"));
    expect(v.keep).toBe(true);
    expect(v.notes).toContain("← tab");
  });
});

describe("an anagram argument may itself carry a predicate", () => {
  it("rearranges only the entries the predicate keeps", async () => {
    // The list is anna, kayak, beast; the palindrome keeps anna and kayak.
    const q = "{anagram {palindrome:{list:anna,kayak,beast}}:A*}";
    expect((await verdict(q, "naan")).keep).toBe(true);
    expect((await verdict(q, "tsabe")).keep).toBe(false);
  });
});

describe("what does not compose says why", () => {
  it("still refuses the same wrapper twice", () => {
    expect(() => parseFilterWrappers("{palindrome:{palindrome:A{5}}}")).toThrow(
      /applied twice/,
    );
  });
});
