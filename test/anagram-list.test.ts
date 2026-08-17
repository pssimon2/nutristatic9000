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
import { parseFilterWrappers } from "../src/result-filter.js";
import { applyResultFilters } from "../src/result-predicate.js";

const ctx = new SessionContext();
beforeAll(() => {
  ctx.lists = parseWikiLists(fs.readFileSync("web/public/lists.txt", "utf8"));
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

  it("drops everything for a list that does not exist", async () => {
    expect((await check("{anagram qqzzxx:A*}", "serial")).keep).toBe(false);
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
