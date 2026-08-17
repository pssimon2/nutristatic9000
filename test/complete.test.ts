// Completions in the query box.
//
// The point of these is not that the menu looks nice: it is that the menu is
// generated from the same catalogue the parser dispatches on, so it can never
// offer something the engine will then reject. The tests below are mostly
// about *where* the cursor is, which is the part that goes wrong.

import { describe, expect, it } from "vitest";
import { completionsAt, tokenAt } from "../src/complete.js";
import { parseWikiLists } from "../src/word-lists.js";
import { compileQuery } from "../src/find-expr.js";
import { CONSTRUCTS } from "../src/constructs.js";
import { parseFilterWrapper } from "../src/result-filter.js";
import { SessionContext } from "../src/session-context.js";

const lists = parseWikiLists("romandeities\tRoman deities\tjuno,mars,venus\n");
const labels = (q: string, cur = q.length) =>
  completionsAt(q, cur, lists).items.map((i) => i.label);
const inserts = (q: string, cur = q.length) =>
  completionsAt(q, cur, lists).items.map((i) => i.insert);

describe("finding the token under the cursor", () => {
  it("completes a construct name after a brace", () => {
    expect(tokenAt("{rot", 4)).toEqual({
      kind: "construct",
      prefix: "rot",
      start: 1,
    });
  });

  it("completes a construct mid-query, not just at the start", () => {
    expect(tokenAt("A{5}&{ci", 8)).toEqual({
      kind: "construct",
      prefix: "ci",
      start: 6,
    });
  });

  it("completes a list argument", () => {
    expect(tokenAt("{list:gre", 9)).toEqual({
      kind: "listname",
      prefix: "gre",
      start: 6,
    });
  });

  it("offers nothing once the construct's argument is a pattern", () => {
    expect(tokenAt("{sum=52:A*", 10).kind).toBe("none");
    expect(tokenAt("abc", 3).kind).toBe("none");
  });

  it("reads the cursor, not the end of the text", () => {
    // Cursor sits inside "{ro|t180}", so the token is "ro".
    expect(tokenAt("{rot180}", 3)).toEqual({
      kind: "construct",
      prefix: "ro",
      start: 1,
    });
  });

  it("stops offering list names once an inline list is being written", () => {
    // `{list:red,gre` is the user's own list; there is nothing to look up.
    expect(tokenAt("{list:red,gre", 13).kind).toBe("none");
  });

  it("keeps digits, which are part of the name", () => {
    expect(tokenAt("{rot13", 6).prefix).toBe("rot13");
    expect(tokenAt("{row1", 5).prefix).toBe("row1");
    // But a quantifier is not a construct.
    expect(completionsAt("A{5", 3).items).toEqual([]);
  });
});

describe("what is offered", () => {
  it("offers the group when the family name is typed", () => {
    expect(labels("{ci")).toContain("cipher.");
  });

  it("finds a construct through its group, and inserts that spelling", () => {
    // Someone typing "ci" meant the cipher family; completing to a bare
    // "rot:" would drop what they wrote.
    expect(inserts("{ci")).toContain("cipher.rot13:");
    expect(inserts("{ci")).not.toContain("rot13:");
  });

  it("inserts the bare name when the bare name was typed", () => {
    expect(inserts("{rot1")).toContain("rot13:");
  });

  it("separates the two rot constructs by their families", () => {
    const all = labels("{rot");
    expect(all).toContain("rot13:");
    expect(all).toContain("rot180:");
  });

  it("offers built-in and harvested lists together", () => {
    expect(labels("{list:gre")).toContain("greek");
    expect(labels("{list:roman")).toContain("romandeities");
  });

  it("says nothing about harvested lists before the catalogue arrives", () => {
    // Until a query has needed it, the page only knows the built-ins.
    const early = completionsAt("{list:roman", 11, null).items.map((i) => i.label);
    expect(early).not.toContain("romandeities");
  });

  it("carries a summary and an example for each construct", () => {
    const item = completionsAt("{palindrome", 11, lists).items[0];
    expect(item.detail).toMatch(/backwards/);
    expect(item.example).toMatch(/^\{palindrome/);
  });
});

describe("every completion is something the engine accepts", () => {
  const ctx = new SessionContext();

  it("accepts the offered example for every construct, at its own level", () => {
    // A menu that suggests what the parser rejects is worse than no menu. The
    // level matters: a whole-query predicate is peeled off before the engine
    // sees it, so it goes through the wrapper parser instead.
    for (const c of CONSTRUCTS) {
      let err: unknown = null;
      try {
        if (c.level === "automaton") compileQuery(c.example, ctx);
        else expect(parseFilterWrapper(c.example), c.name).not.toBeNull();
      } catch (e) {
        err = e;
      }
      // Data-backed constructs are fine to "fail" for want of a dataset this
      // test deliberately does not load.
      const dataMissing =
        err !== null && (err as { dataMissing?: boolean }).dataMissing === true;
      expect(err === null || dataMissing, `${c.name}: ${c.example}`).toBe(true);
    }
  });
});

// `{kind:…}` is the other argument drawn from a fixed vocabulary, and the one
// you cannot guess: "bird", "bird family" and "birdnesting" are all WordNet
// names, and nothing outside the dataset tells you which exists. The menu is
// filled by the worker — 124,980 names is not a thing to hand the page — so
// what happens here is only the recognition that the cursor is in one.
describe("category arguments", () => {
  const kindAt = (q: string) => tokenAt(q, q.length);

  it("recognises the argument of {kind:…}", () => {
    expect(kindAt("{kind:bir")).toMatchObject({ kind: "kindname", prefix: "bir" });
    expect(kindAt("{kind:")).toMatchObject({ kind: "kindname", prefix: "" });
  });

  it("recognises the prefixed spelling too", () => {
    expect(kindAt("A{5}&{word.kind:inst")).toMatchObject({
      kind: "kindname",
      prefix: "inst",
    });
  });

  it("offers nothing itself — the worker answers this one", () => {
    expect(completionsAt("{kind:bir", 9).items).toEqual([]);
  });

  it("does not mistake other constructs for it", () => {
    expect(kindAt("{list:gre").kind).toBe("listname");
    expect(kindAt("{rot13:abc").kind).toBe("none");
  });
});

// A construct whose argument comes before the colon.
//
// `{anagram countries:A{6}}` names its list before the colon, because the colon
// introduces the pattern it wraps. Completing it to "anagram:" inserted a form
// that cannot parse, and the list position offered nothing at all — the menu
// was leading people into an error on the construct they had just found.
describe("completing {anagram <list>:…}", () => {
  it("completes the name to a space, not a colon", () => {
    const { items } = completionsAt("{anag", 5, null);
    expect(items[0].insert).toBe("anagram ");
  });

  it("leaves every other construct completing to a colon", () => {
    expect(completionsAt("{palind", 7, null).items[0].insert).toBe("palindrome:");
    expect(completionsAt("{compo", 6, null).items[0].insert).toBe("compound:");
  });

  it("completes list names in the argument position", () => {
    const { token, items } = completionsAt("{anagram cou", 12, null);
    expect(token.kind).toBe("listname");
    expect(items.map((i) => i.insert)).toContain("countries");
  });

  it("offers the whole catalogue with nothing typed yet", () => {
    const { token, items } = completionsAt("{anagram ", 9, null);
    expect(token.kind).toBe("listname");
    expect(items.length).toBeGreaterThan(5);
  });

  it("takes the group prefix here too", () => {
    expect(completionsAt("{match.anagram gr", 17, null).token.kind).toBe("listname");
  });
});
