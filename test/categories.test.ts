import * as fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import {
  kindsOf,
  needsCategories,
  parseCategories,
  setCategories,
} from "../src/categories.js";

function matches(pattern: string, text: string): boolean {
  const filter = compileQuery(pattern);
  let state = filter.startState;
  for (const ch of `${text} `) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

beforeAll(() => {
  setCategories(parseCategories(fs.readFileSync("web/public/categories.txt", "utf8")));
});

describe("categories", () => {
  it("knows which queries need the graph", () => {
    expect(needsCategories("{kind:bird}")).toBe(true);
    expect(needsCategories("{like:bird}")).toBe(false);
  });

  it("walks the whole hierarchy, not one level", () => {
    const birds = kindsOf("bird")!;
    expect(birds).toContain("bird"); // the word itself is one
    expect(birds).toContain("penguin");
    expect(birds).toContain("bittern"); // several levels down
    expect(birds.length).toBeGreaterThan(1000);
  });

  it("keeps multi-word names, since the corpus indexes phrases", () => {
    expect(kindsOf("bird")).toContain("bald eagle");
  });

  it("refuses a category that is really the dictionary", () => {
    // ENTITY sits at the root of every noun in WordNet.
    expect(kindsOf("entity")).toBeNull();
    expect(kindsOf("zzzqq")).toBeNull();
  });

  it("composes with the pattern, which is the whole point", () => {
    expect(matches("{kind:bird}&A{7}", "penguin")).toBe(true);
    expect(matches("{kind:bird}&A{7}", "kitchen")).toBe(false);
    expect(matches("{kind:tree}&A{5}", "maple")).toBe(true);
  });

  it("explains an unusable category", () => {
    const nfa = new Nfa();
    expect(() => parseExpr("{kind:zzzqq}", 0, nfa, false)).toThrow(
      /no category "zzzqq"/,
    );
  });
});
