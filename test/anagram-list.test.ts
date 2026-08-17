// Rearranging a set, which `<…>` cannot do.
//
// Asked for: "could we do an operation that expands something to characters so
// I can find anagrams of countries?" `<…>` rearranges the parts written between
// the brackets, so there is no way to spell out "any country" — but asked of a
// finished match it is a lookup: sort the letters and see whether any entry of
// the list sorts the same.

import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { SessionContext } from "../src/session-context.js";
import { parseWikiLists, needsWikiLists } from "../src/word-lists.js";
import { parseCategories } from "../src/categories.js";
import { parseFilterWrappers } from "../src/result-filter.js";
import { applyResultFilters } from "../src/result-predicate.js";

const ctx = new SessionContext();
beforeAll(() => {
  ctx.lists = parseWikiLists(fs.readFileSync("web/public/lists.txt", "utf8"));
  // The argument may be a construct with a dataset of its own —
  // `{anagram {kind:bird}:…}` — and `providersFor` reports that dataset
  // through the nesting, so a run has it loaded.
  ctx.categories = parseCategories(
    fs.readFileSync("web/public/categories.txt", "utf8"),
  );
});

const never = () => false;
async function check(query: string, text: string) {
  const { specs } = parseFilterWrappers(query);
  return applyResultFilters(specs, text, ctx, never as never);
}

describe("parsing", () => {
  it("reads the list name from before the colon", () => {
    const { specs, inner } = parseFilterWrappers("{anagram countries:A{6}}");
    expect(specs).toEqual([{ kind: "anagram", list: "countries" }]);
    expect(inner).toBe("A{6}");
  });

  it("needs a list to rearrange", () => {
    expect(() => parseFilterWrappers("{anagram:A{6}}")).toThrow(/needs a list/);
  });

  it("takes the group prefix like every other construct", () => {
    expect(parseFilterWrappers("{match.anagram countries:A{6}}").specs).toEqual([
      { kind: "anagram", list: "countries" },
    ]);
  });
});

describe("deciding a match", () => {
  it("keeps a rearrangement and names what it came from", async () => {
    expect(await check("{anagram countries:A*}", "serial")).toEqual({
      keep: true,
      notes: ["← israel"],
    });
    expect((await check("{anagram countries:A*}", "panel")).notes).toEqual([
      "← nepal",
    ]);
  });

  it("keeps a rearrangement that falls into several words", async () => {
    // The index reports phrases, and "is real" is as good an answer as
    // "serial" — the letters are what matter.
    expect((await check("{anagram countries:A*}", "is real")).notes).toEqual([
      "← israel",
    ]);
  });

  it("drops the entry itself", async () => {
    // Every member trivially rearranges to itself, and "canada ← canada" is
    // not an answer. Same rule as {reversible:…} excluding a palindrome.
    expect((await check("{anagram countries:A*}", "canada")).keep).toBe(false);
    expect((await check("{anagram countries:A*}", "israel")).keep).toBe(false);
  });

  it("drops a word that rearranges nothing in the list", async () => {
    expect((await check("{anagram countries:A*}", "orange")).keep).toBe(false);
  });

  it("reads a name that is not a list as a word to rearrange", async () => {
    // A mistyped list name and a word are the same thing written down, so the
    // rule is plain: a list if it is one, otherwise the word. "serial" does not
    // rearrange "qqzzxx".
    expect((await check("{anagram qqzzxx:A*}", "serial")).keep).toBe(false);
    expect((await check("{anagram qqzzxx:A*}", "qzqxzx")).keep).toBe(true);
  });

  it("works on a bundled list as well as a harvested one", async () => {
    expect((await check("{anagram greek:A*}", "eat")).notes).toEqual(["← eta"]);
    // "sunev" is VENUS rearranged — the letters are what matter, not whether
    // the result looks like a word.
    expect((await check("{anagram romandeities:A*}", "sunev")).notes).toEqual([
      "← venus",
    ]);
  });
});

describe("the catalogue it needs", () => {
  it("is fetched for a harvested list", () => {
    // The name sits *before* the colon here, since the colon introduces the
    // pattern — so the sniffer has to look in a different place than for
    // `{list:…}`.
    expect(needsWikiLists("{anagram romandeities:A*}")).toBe(true);
  });

  it("is not fetched for a bundled one", () => {
    expect(needsWikiLists("{anagram greek:A*}")).toBe(false);
    expect(needsWikiLists("{anagram countries:A*}")).toBe(false);
  });

  it("still reads {list:…} the way it always did", () => {
    expect(needsWikiLists("{list:romandeities}")).toBe(true);
    expect(needsWikiLists("{list:greek}")).toBe(false);
  });
});

// The argument may be any pattern with a set small enough to hold, not only a
// list name. Asked for: "the anagram thing only works on lists? I want it to be
// able to wrap anything."
describe("rearranging whatever a pattern matches", () => {
  it("takes a nested construct as its argument", async () => {
    // GANDER rearranges to GARDEN, and a bird is not a list name.
    expect((await check("{anagram {kind:bird}:A*}", "garden")).notes).toEqual([
      "← gander",
    ]);
  });

  it("takes a list written the long way, and agrees with the short way", async () => {
    const long = await check("{anagram {list:countries}:A*}", "panel");
    const short = await check("{anagram countries:A*}", "panel");
    expect(long).toEqual(short);
    expect(long.notes).toEqual(["← nepal"]);
  });

  it("takes an edit construct as its argument", async () => {
    // BEAT is BEAST minus an S, and TABS rearranges BAST.
    expect((await check("{anagram {del1:beast}:A*}", "beta")).keep).toBe(true);
  });

  it("parses a spec containing braces and colons", () => {
    // The colon that ends the spec is the one at brace depth zero; the spec
    // used to stop at the first `:` or `}` it saw.
    const { specs, inner } = parseFilterWrappers("{anagram {kind:bird}:A{6}}");
    expect(specs).toEqual([{ kind: "anagram", list: "{kind:bird}" }]);
    expect(inner).toBe("A{6}");
  });

  it("says so when the argument cannot be listed out", async () => {
    // Silently dropping every candidate reported "no results", which is the
    // one answer that cannot be acted on.
    await expect(check("{anagram A*:A{5}}", "abcde")).rejects.toThrow(
      /needs something it can list out/,
    );
    // A pattern, not a name: `listKey` would strip the punctuation and could
    // pick up a list by accident, so only name-shaped arguments try that path.
    await expect(check("{anagram A{5}&C*:A{5}}", "abcde")).rejects.toThrow(
      /needs something it can list out/,
    );
  });
});

// A bare word as the argument, which is what anyone would try first.
describe("rearranging a single word", () => {
  it("takes a plain word", async () => {
    // BEATS and BATES rearrange BEAST.
    expect((await check("{anagram beast:A*}", "beats")).notes).toEqual([
      "← beast",
    ]);
    expect((await check("{anagram listen:A*}", "silent")).notes).toEqual([
      "← listen",
    ]);
  });

  it("does not treat the word's optional spaces as part of it", () => {
    // The reason this needed doing: an unquoted atom carries an
    // optional-space self-loop — what lets `solar s_stem` match "solar system"
    // — so the language of a bare `cargo` is "cargo", "c argo", "c  argo" and
    // on forever, and the argument was refused for being unbounded.
    expect(() => parseFilterWrappers("{anagram cargo:A*}")).not.toThrow();
  });

  it("still refuses one that is unbounded even quoted", async () => {
    await expect(check("{anagram A*:A{5}}", "abcde")).rejects.toThrow(
      /needs something it can list out/,
    );
  });

  it("says so every time, not only the first", async () => {
    // The failure is deliberately not cached: caching it made this say its
    // piece once and then drop every later candidate in silence, so a second
    // run of the same query in one session reported "no results".
    for (let i = 0; i < 3; ++i) {
      await expect(
        check("{anagram A*:A{5}}", "abcde"),
        `attempt ${i + 1}`,
      ).rejects.toThrow(/needs something it can list out/);
    }
  });

  it("leaves the word itself out, as it does for a list", async () => {
    expect((await check("{anagram beast:A*}", "beast")).keep).toBe(false);
  });
});

// An intersection as the argument.
describe("rearranging an intersection", () => {
  it("lists out the smallest part and filters by the rest", async () => {
    // Twenty-four Greek letters narrowed to five characters: THETA and DELTA.
    // Refused before, for being written as two conjuncts rather than for being
    // large.
    expect((await check("{anagram {list:greek}&A{5}:A*}", "at the")).notes)
      .toEqual(["← theta"]);
    expect((await check("{anagram {list:greek}&A{5}:A*}", "dealt")).notes)
      .toEqual(["← delta"]);
  });

  it("honours the narrowing rather than ignoring it", async () => {
    // PI is Greek but not five characters, so nothing rearranges it here.
    expect((await check("{anagram {list:greek}&A{5}:A*}", "ip")).keep).toBe(false);
    // ...and it does when the narrowing allows it.
    expect((await check("{anagram {list:greek}:A*}", "ip")).notes).toEqual(["← pi"]);
  });

  it("keeps phrases, which the search strategy's own rule would drop", async () => {
    // `finiteCandidates` refuses a candidate set containing spaces, because the
    // walk may assemble a phrase from several index entries and a probe cannot
    // price that. Here only the letters matter, and 68% of WordNet's birds are
    // phrases — reusing that rule dropped {kind:bird} entirely.
    expect((await check("{anagram {kind:bird}:A*}", "garden")).notes).toEqual([
      "← gander",
    ]);
  });
});
