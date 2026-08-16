import * as fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import {
  nearestTo,
  needsNeighbours,
  parseNeighbours,
} from "../src/neighbours.js";
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
  const buf = fs.readFileSync("web/public/neighbours.bin");
  ctx.neighbours = parseNeighbours( buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), );
});

describe("semantic neighbours", () => {
  it("knows which queries need the table", () => {
    expect(needsNeighbours("{near:king}")).toBe(true);
    expect(needsNeighbours("{like:king}")).toBe(false);
  });

  it("finds words a thesaurus would miss", () => {
    // The whole reason for this alongside {like:…}: WordNet groups RELUCTANT
    // with LOATH, but not with these.
    const near = nearestTo(ctx.neighbours, "reluctant", 40)!;
    expect(near).toContain("reluctant"); // the word itself leads
    expect(near).toContain("unwilling");
    expect(near).toContain("hesitant");
  });

  it("reaches the vocabulary a solver actually needs", () => {
    // Words like these are why the vocabulary runs to 60k rather than 20k.
    for (const w of ["cipher", "azure", "treachery", "obelisk"]) {
      expect(nearestTo(ctx.neighbours, w), w).not.toBeNull();
    }
    expect(nearestTo(ctx.neighbours, "cipher", 40)).toContain("cryptography");
    expect(nearestTo(ctx.neighbours, "azure", 40)).toContain("cerulean");
  });

  it("keeps WordNet's antonyms out", () => {
    // Every embedding tested put opposites in the top 40 (38-63% of gold
    // pairs); the build strips the ones WordNet can name.
    expect(nearestTo(ctx.neighbours, "quick", 40)).not.toContain("slow");
    expect(nearestTo(ctx.neighbours, "hot", 40)).not.toContain("cold");
    expect(nearestTo(ctx.neighbours, "increase", 40)).not.toContain("decrease");
    // ...without costing the synonyms.
    expect(nearestTo(ctx.neighbours, "quick", 40)).toContain("rapid");
    expect(nearestTo(ctx.neighbours, "hot", 40)).toContain("scorching");
  });

  it("honours the requested count", () => {
    expect(nearestTo(ctx.neighbours, "king", 8)!.length).toBeLessThanOrEqual(9); // + the word
    expect(nearestTo(ctx.neighbours, "king", 40)!.length).toBeGreaterThan(20);
  });

  it("reports a word outside the vocabulary", () => {
    expect(nearestTo(ctx.neighbours, "zzzqq")).toBeNull();
    const nfa = new Nfa();
    expect(() => parseExpr("{near:zzzqq}", 0, nfa, false, ctx)).toThrow(
      /not in the meaning vocabulary/,
    );
  });

  it("composes with the pattern, which is what makes it usable", () => {
    expect(matches("{near:king}&A{7}", "monarch")).toBe(true);
    expect(matches("{near:king}&A{7}", "bananas")).toBe(false);
  });
});
