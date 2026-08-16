import * as fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import {
  kindsOf,
  needsCategories,
  parseCategories,
  suggestKinds,
} from "../src/categories.js";
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
  ctx.categories = parseCategories(fs.readFileSync("web/public/categories.txt", "utf8"));
});

describe("categories", () => {
  it("knows which queries need the graph", () => {
    expect(needsCategories("{kind:bird}")).toBe(true);
    expect(needsCategories("{like:bird}")).toBe(false);
  });

  it("walks the whole hierarchy, not one level", () => {
    const birds = kindsOf(ctx.categories, "bird")!;
    expect(birds).toContain("bird"); // the word itself is one
    expect(birds).toContain("penguin");
    expect(birds).toContain("bittern"); // several levels down
    expect(birds.length).toBeGreaterThan(1000);
  });

  it("keeps multi-word names, since the corpus indexes phrases", () => {
    expect(kindsOf(ctx.categories, "bird")).toContain("bald eagle");
  });

  it("refuses a category that is really the dictionary", () => {
    // ENTITY sits at the root of every noun in WordNet.
    expect(kindsOf(ctx.categories, "entity")).toBeNull();
    expect(kindsOf(ctx.categories, "zzzqq")).toBeNull();
  });

  it("composes with the pattern, which is the whole point", () => {
    expect(matches("{kind:bird}&A{7}", "penguin")).toBe(true);
    expect(matches("{kind:bird}&A{7}", "kitchen")).toBe(false);
    expect(matches("{kind:tree}&A{5}", "maple")).toBe(true);
  });

  it("explains an unusable category", () => {
    const nfa = new Nfa();
    expect(() => parseExpr("{kind:zzzqq}", 0, nfa, false, ctx)).toThrow(
      /no category "zzzqq"/,
    );
  });
});

// Completing `{kind:…}`. The vocabulary is 124,980 WordNet names and no part
// of it is guessable from outside — "bird", "bird family" and "birdnesting"
// all exist — so the menu is the only way to find out what you may type.
describe("suggesting category names", () => {
  it("offers the names that start with what was typed", () => {
    const hits = suggestKinds(ctx.categories, "bird", 6);
    expect(hits).toContain("bird");
    for (const h of hits) expect(h.startsWith("bird")).toBe(true);
  });

  it("puts the shorter name first, since a prefix usually is the word", () => {
    const hits = suggestKinds(ctx.categories, "cheese", 6);
    expect(hits[0]).toBe("cheese");
    for (let i = 1; i < hits.length; ++i) {
      expect(hits[i].length).toBeGreaterThanOrEqual(hits[i - 1].length);
    }
  });

  it("offers nothing for an empty prefix", () => {
    // 124,980 names cannot be ranked by a prefix that is not there; sorting
    // them by length offers "0", "1", "2", which the dataset does contain.
    expect(suggestKinds(ctx.categories, "")).toEqual([]);
    expect(suggestKinds(ctx.categories, "   ")).toEqual([]);
  });

  it("offers nothing for a prefix no category has", () => {
    expect(suggestKinds(ctx.categories, "zzzq")).toEqual([]);
  });

  it("offers nothing rather than throwing with no dataset", () => {
    expect(suggestKinds(null, "bird")).toEqual([]);
  });

  it("suggests only names the engine then accepts", () => {
    // A menu that offers what the parser rejects is worse than no menu.
    for (const name of suggestKinds(ctx.categories, "inst", 5)) {
      expect(kindsOf(ctx.categories, name), name).not.toBeNull();
    }
  });
});
