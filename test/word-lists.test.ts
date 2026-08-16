import { describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import { entriesNfa, listNames, normalizeEntry, wordList } from "../src/word-lists.js";
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
