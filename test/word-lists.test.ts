import { describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import { listNames, normalizeEntry, wordList } from "../src/word-lists.js";
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
