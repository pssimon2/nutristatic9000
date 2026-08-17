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

  it("says so for a list that does not exist", async () => {
    // Dropping every candidate silently reported "no results", which is the
    // one answer a reader cannot act on.
    await expect(check("{anagram qqzzxx:A*}", "serial")).rejects.toThrow(
      /not a list this build knows/,
    );
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
    await expect(check("{anagram qqzz:A{5}}", "abcde")).rejects.toThrow(
      /not a list this build knows/,
    );
  });
});
