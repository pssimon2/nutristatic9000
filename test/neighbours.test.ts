import * as fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import {
  nearestTo,
  needsNeighbours,
  parseNeighbours,
  setNeighbours,
} from "../src/neighbours.js";

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
  const buf = fs.readFileSync("web/public/neighbours.bin");
  setNeighbours(
    parseNeighbours(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    ),
  );
});

describe("semantic neighbours", () => {
  it("knows which queries need the table", () => {
    expect(needsNeighbours("{near:king}")).toBe(true);
    expect(needsNeighbours("{like:king}")).toBe(false);
  });

  it("finds words a thesaurus would miss", () => {
    // The whole reason for this alongside {like:…}: WordNet groups RELUCTANT
    // with LOATH, but not with these.
    const near = nearestTo("reluctant", 48)!;
    expect(near).toContain("reluctant"); // the word itself leads
    expect(near.some((w) => ["willing", "refused", "opposed"].includes(w))).toBe(
      true,
    );
  });

  it("honours the requested count", () => {
    expect(nearestTo("king", 8)!.length).toBeLessThanOrEqual(9); // + the word
    expect(nearestTo("king", 40)!.length).toBeGreaterThan(20);
  });

  it("reports a word outside the vocabulary", () => {
    expect(nearestTo("zzzqq")).toBeNull();
    const nfa = new Nfa();
    expect(() => parseExpr("{near:zzzqq}", 0, nfa, false)).toThrow(
      /not in the meaning vocabulary/,
    );
  });

  it("composes with the pattern, which is what makes it usable", () => {
    expect(matches("{near:king}&A{7}", "monarch")).toBe(true);
    expect(matches("{near:king}&A{7}", "bananas")).toBe(false);
  });
});
