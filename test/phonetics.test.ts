import * as fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import {
  homophonesOf,
  needsPhonetics,
  parsePhonetics,
  rhymesOf,
} from "../src/phonetics.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

function matches(pattern: string, text: string): boolean {
  const filter = compileQuery(pattern, ctx);
  let state = filter.startState;
  for (const ch of `${text} `) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

beforeAll(() => {
  ctx.phonetics = parsePhonetics(fs.readFileSync("web/public/phonetics.txt", "utf8"));
});

describe("phonetics", () => {
  it("knows which queries need the dictionary", () => {
    expect(needsPhonetics("{rhyme:tree}")).toBe(true);
    expect(needsPhonetics("{homo:knight}")).toBe(true);
    expect(needsPhonetics("A{5}")).toBe(false);
  });

  it("rhymes from the last primary-stressed vowel", () => {
    const tree = rhymesOf(ctx.phonetics, "tree")!;
    expect(tree).toContain("free");
    expect(tree).toContain("we");
    // ANti carries its stress on the first syllable: it rhymes with AUNTIE,
    // not TREE, even though its final IY takes secondary stress.
    expect(tree).not.toContain("anti");
    expect(tree).not.toContain("cat");
  });

  it("finds homophones", () => {
    const knight = homophonesOf(ctx.phonetics, "knight")!;
    expect(knight).toContain("night");
    expect(knight).toContain("knight");
    // The dictionary carries surnames and variant spellings, so homophone
    // groups are wider than a dictionary of common words would give: CAT has
    // CATT, KAT and KATT. Only a word it doesn't know at all comes back null.
    expect(homophonesOf(ctx.phonetics, "zzzqq")).toBeNull();
  });

  it("says so for words it doesn't know", () => {
    expect(rhymesOf(ctx.phonetics, "zzzqq")).toBeNull();
    // Orange really has no rhyme, so it forms no group.
    expect(rhymesOf(ctx.phonetics, "orange")).toBeNull();
  });

  it("matches through the pattern language and composes", () => {
    expect(matches("{rhyme:night}&A{5}", "light")).toBe(true);
    expect(matches("{rhyme:night}&A{5}", "cats")).toBe(false);
    expect(matches("{homo:knight}", "nite")).toBe(true);
  });

  it("explains an unknown word rather than failing to parse", () => {
    const nfa = new Nfa();
    expect(() => parseExpr("{rhyme:zzzqq}", 0, nfa, false, ctx)).toThrow(
      /doesn't know "zzzqq"/,
    );
  });
});

describe("constructs after an atom", () => {
  it("only reads {m,n} as a quantifier", () => {
    // `A* {rhyme:day}` used to fail: the brace was taken for a quantifier.
    expect(matches("A* {rhyme:day}", "in a")).toBe(true);
    expect(matches("the {list:greek}", "the beta")).toBe(true);
    // Real quantifiers keep working.
    expect(matches("A{4}", "that")).toBe(true);
    expect(matches("A{2,4}", "the")).toBe(true);
    expect(matches("A{2,4}", "abcde")).toBe(false);
  });
});
