import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import {
  entriesNfa,
  listKey,
  listNames,
  needsWikiLists,
  normalizeEntry,
  parseWikiLists,
  suggestList,
  wordList,
} from "../src/word-lists.js";
import { equivalent } from "../src/automata.js";
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

describe("word lists", () => {
  it("has the expected sizes", () => {
    const sizes = Object.fromEntries(
      listNames().map((n) => [n, wordList(n)!.length]),
    );
    expect(sizes).toMatchObject({
      greek: 24,
      nato: 26,
      months: 12,
      days: 7,
      zodiac: 12,
      planets: 8,
      chesspieces: 6,
      suits: 4,
      compass: 8,
      rainbow: 7,
      reindeer: 9,
      hogwarts: 4,
      dwarfplanets: 5,
      wonders: 7,
      solfege: 7,
      resistors: 10,
      cluesuspects: 7,
      clueweapons: 8,
      cluerooms: 9,
      apostles: 12,
      virtues: 12,
      monopoly: 28,
      siprefixes: 24,
    });
  });

  it("stores entries the way the corpus does", () => {
    expect(normalizeEntry("Cote d'Ivoire")).toBe("cote divoire");
    expect(normalizeEntry("Guinea-Bissau")).toBe("guinea bissau");
    for (const name of listNames()) {
      for (const entry of wordList(name)!) {
        expect(entry).toMatch(/^[a-z0-9]+( [a-z0-9]+)*$/);
      }
    }
  });

  it("resolves aliases", () => {
    expect(wordList("greekletters")).toEqual(wordList("greek"));
    expect(wordList("chess")).toEqual(wordList("chesspieces"));
    expect(wordList("nosuchlist")).toBeNull();
  });
});

describe("{list:…} in patterns", () => {
  it("matches any entry and nothing else", () => {
    expect(matches("{list:greek}", "sigma")).toBe(true);
    expect(matches("{list:greek}", "sigmas")).toBe(false);
    expect(matches("{list:planets}", "neptune")).toBe(true);
    expect(matches("{list:planets}", "pluto")).toBe(false);
  });

  it("composes, so a category can hide inside a phrase", () => {
    expect(matches(".*{list:chess}.*", "the knight moves")).toBe(true);
    expect(matches("{list:days}&A{6}", "friday")).toBe(true);
    expect(matches("{list:days}&A{6}", "tuesday")).toBe(false); // wrong length
  });

  it("explains an unknown list instead of just failing to parse", () => {
    const nfa = new Nfa();
    expect(() => parseExpr("{list:nosuch}", 0, nfa, false, ctx)).toThrow(
      /no such list "nosuch"/,
    );
  });
});

describe("inline lists", () => {
  it("accepts entries written in the query", () => {
    expect(matches("{list:red,green,blue}", "green")).toBe(true);
    expect(matches("{list:red,green,blue}", "yellow")).toBe(false);
  });

  it("normalises inline entries like the corpus", () => {
    expect(matches("{list:New York,Los Angeles}", "new york")).toBe(true);
    expect(matches("{list:cote d'ivoire,peru}", "cote divoire")).toBe(true);
  });

  it("reads a comma-free argument as a list name, not one entry", () => {
    // {list:sigma} would be a lookup and there is no such list; a trailing
    // comma says "these are the entries".
    expect(() => matches("{list:sigma}", "sigma")).toThrow();
    expect(matches("{list:sigma,}", "sigma")).toBe(true);
  });

  it("composes like a named list", () => {
    expect(matches(".*{list:red,green,blue}.*", "credit")).toBe(true);
    expect(matches("{list:red,green,blue}&A{3}", "red")).toBe(true);
    expect(matches("{list:red,green,blue}&A{3}", "blue")).toBe(false);
  });

  it("still resolves named lists", () => {
    expect(matches("{list:greek}", "sigma")).toBe(true);
  });
});

describe("entriesNfa is a prefix trie", () => {
  /** The previous construction: one chain per entry, unioned. */
  function chainsNfa(entries: string[]): Nfa | null {
    if (entries.length === 0) return null;
    let out: Nfa | null = null;
    for (const entry of entries) {
      const nfa = new Nfa();
      let state = nfa.addState();
      nfa.setStart(state);
      for (const ch of entry) {
        const next = nfa.addState();
        nfa.addArc(state, ch.charCodeAt(0), next);
        state = next;
      }
      nfa.setFinal(state);
      if (out === null) out = nfa;
      else out.union(nfa);
    }
    return out;
  }

  const samples: Array<[string, string[]]> = [
    ["shared prefixes", ["cart", "carton", "car", "cat", "dog"]],
    ["one entry a prefix of another", ["dove", "doves", "dov"]],
    ["duplicates", ["owl", "owl", "owl"]],
    ["multiword entries", ["bald eagle", "bald ibis", "barn owl"]],
    ["nothing shared", ["alpha", "beta", "gamma"]],
    ["single entry", ["x"]],
    ["a real list", wordList("greek")!],
  ];

  for (const [name, entries] of samples) {
    it(`accepts the same language as union-of-chains: ${name}`, () => {
      const trie = entriesNfa(entries)!;
      const chains = chainsNfa(entries)!;
      expect(equivalent(trie, chains)).toBe(true);
    });
  }

  it("shares prefixes rather than repeating them", () => {
    const entries = ["carton", "cartoon", "cartel"];
    const trie = entriesNfa(entries)!;
    const chains = chainsNfa(entries)!;
    const count = (n: Nfa) => n.arcs.reduce((t, l) => t + l.length, 0);
    expect(count(trie)).toBeLessThan(count(chains));
    // "cart" is written once, not three times.
    expect(count(trie)).toBe(new Set(
      entries.flatMap((e) => [...e].map((_, i) => e.slice(0, i + 1))),
    ).size);
  });
});

describe("the shipped list catalogue", () => {
  it("stores multiword entries whole", () => {
    // Entries are comma-separated precisely so a space can appear inside one.
    // Space-separating turned "antigua and barbuda" into three entries, which
    // made {list:countries} match the word AND.
    const countries = wordList("countries")!;
    expect(countries).toContain("antigua and barbuda");
    expect(countries).toContain("united states");
    expect(countries).not.toContain("and");
    expect(countries).not.toContain("united");
  });

  it("matches whole multiword entries and nothing less", () => {
    expect(matches("{list:countries}", "united states")).toBe(true);
    expect(matches("{list:countries}", "france")).toBe(true);
    expect(matches("{list:countries}", "and")).toBe(false);
    expect(matches("{list:continents}", "north america")).toBe(true);
    expect(matches("{list:tarot}", "wheel of fortune")).toBe(true);
  });

  it("resolves the names a solver would actually type", () => {
    expect(wordList("country")).toBe(wordList("countries"));
    expect(wordList("state")).toBe(wordList("usstates"));
    expect(wordList("element")).toBe(wordList("elements"));
    expect(wordList("dwarves")).toBe(wordList("dwarfs"));
  });

  it("folds diacritics so entries can match the folded corpus", () => {
    // Boötes reached the list as "bo tes" before folding was added, and so
    // could never match anything the index holds.
    const c = wordList("constellations")!;
    expect(c).toContain("bootes");
    expect(c).not.toContain("bo tes");
  });

  it("keeps every entry in corpus form", () => {
    for (const name of listNames()) {
      const entries = wordList(name)!;
      expect(entries.length, name).toBeGreaterThan(0);
      for (const e of entries) {
        // Lowercase, single-spaced, no punctuation: exactly what the index
        // stores, or the entry is unmatchable.
        expect(e, `${name}: ${JSON.stringify(e)}`).toMatch(/^[a-z0-9]+( [a-z0-9]+)*$/);
      }
    }
  });

  it("has the categories hunts actually ask for", () => {
    for (const name of [
      "countries", "capitals", "usstates", "elements", "constellations",
      "presidents", "bible", "shakespeare", "tarot", "moons", "greekgods",
    ]) {
      expect(listNames(), name).toContain(name);
    }
  });
});

describe("the fetched catalogue", () => {
  const cat = parseWikiLists(
    [
      "romandeities\tRoman deities\tjuno,mars,venus,vesta",
      "frenchdishes\tFrench dishes\tcassoulet,ratatouille",
      "\tbroken line with no body",
    ].join("\n") + "\n",
  );

  it("parses slug, subject and entries", () => {
    expect(cat.entries.get("romandeities")).toEqual([
      "juno",
      "mars",
      "venus",
      "vesta",
    ]);
    expect(cat.subjects.get("frenchdishes")).toBe("French dishes");
  });

  it("skips malformed lines rather than inventing empty lists", () => {
    expect(cat.entries.size).toBe(2);
  });

  it("asks for the catalogue only when the bundle cannot answer", () => {
    // Built in, so no fetch.
    expect(needsWikiLists("{list:greek}")).toBe(false);
    expect(needsWikiLists("{list:countries}&A{6}")).toBe(false);
    // An inline list is self-contained.
    expect(needsWikiLists("{list:red,green,blue}")).toBe(false);
    // Not built in: the catalogue is required before compiling.
    expect(needsWikiLists("{list:romandeities}")).toBe(true);
    expect(needsWikiLists("{word.list:frenchdishes}")).toBe(true);
    // No list at all.
    expect(needsWikiLists("A{5}&C*")).toBe(false);
  });

  it("normalises a written name to its slug", () => {
    expect(listKey(" Roman Deities ")).toBe("romandeities");
    expect(listKey("french-dishes")).toBe("frenchdishes");
  });

  it("suggests a near miss from the built-ins or the catalogue", () => {
    expect(suggestList("countrie", null)).toBe("countries");
    expect(suggestList("romandeity", cat)).toBe("romandeities");
    expect(suggestList("dishes", cat)).toBe("frenchdishes");
    expect(suggestList("zzzzzz", cat)).toBeNull();
  });
});

// The catalogue's entries are members, not table columns.
//
// "List of breads" is a table whose columns are Name, Type and Place of origin,
// and every cell was becoming an entry — so the list read "anadama bread, yeast
// bread, anpan, sweet bun, japan, …". Reported as "some lists have a ton of
// countries in them rather than the content".
describe("the harvested catalogue", () => {
  const lists = parseWikiLists(
    fs.readFileSync("web/public/lists.txt", "utf8"),
  );

  it("has a cheeses list made of cheeses", () => {
    // "List of cheeses" is the same table shape that once polluted breads:
    // columns Name, Type, Place of origin, every cell becoming an entry.
    const cheeses = lists.entries.get("cheeses");
    expect(cheeses, "no cheeses list in the catalogue").toBeTruthy();
    expect(cheeses!.length).toBeGreaterThan(100);
    for (const stray of ["france", "japan", "italy", "germany", "poland"]) {
      expect(cheeses, `${stray} is a place, not a cheese`).not.toContain(stray);
    }
  });

  it("is curated: every list is one someone would reach for in a puzzle", () => {
    // The harvest once shipped 397 lists, most of them noise ("data deficient
    // insects", "Oklahoma ballot measures") that buried the usable ones. The
    // catalogue is now a reviewed set; growing it is fine, but a regenerated
    // harvest dumping hundreds of unreviewed lists back in is a regression.
    expect(lists.entries.size).toBeLessThan(60);
    for (const gen of ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix"]) {
      expect(
        lists.entries.has(`generation${gen}pokemon`),
        `generation ${gen} pokemon missing`,
      ).toBe(true);
    }
  });
});
