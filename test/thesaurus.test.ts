import * as fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { compileQuery } from "../src/find-expr.js";
import {
  needsThesaurus,
  parseThesaurus,
  relatedTo,
} from "../src/thesaurus.js";
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
  ctx.thesaurus = parseThesaurus(fs.readFileSync("web/public/thesaurus.txt", "utf8"));
});

describe("thesaurus", () => {
  it("knows which queries need it", () => {
    expect(needsThesaurus("{like:reluctant}")).toBe(true);
    expect(needsThesaurus("{list:greek}")).toBe(false);
  });

  it("groups words that share a sense", () => {
    const reluctant = relatedTo(ctx.thesaurus, "reluctant")!;
    expect(reluctant).toContain("loath");
    expect(reluctant).toContain("loth");
    expect(relatedTo(ctx.thesaurus, "zzzqq")).toBeNull();
  });

  it("unions every sense of a word", () => {
    // "king" is a monarch, a chess piece and a magnate; all senses reachable.
    const king = relatedTo(ctx.thesaurus, "king")!;
    expect(king).toContain("magnate");
    expect(king.length).toBeGreaterThan(3);
  });

  it("is decisive in combination, which is the point", () => {
    // Five letters, starts with l, means reluctant.
    expect(matches("{like:reluctant}&A{5}&l....", "loath")).toBe(true);
    expect(matches("{like:reluctant}&A{5}&l....", "lousy")).toBe(false);
  });

  it("keeps multi-word senses usable", () => {
    // Tab-separated groups, so a phrase survives as a phrase.
    const groups = parseThesaurus("give up\tabandon\nfoo\tbar\n");
    expect(groups.get("give up")).toContain("abandon");
  });

  it("explains a word it doesn't know", () => {
    const nfa = new Nfa();
    expect(() => parseExpr("{like:zzzqq}", 0, nfa, false, ctx)).toThrow(
      /thesaurus doesn't know "zzzqq"/,
    );
  });
});
