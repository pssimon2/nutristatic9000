// Weighted search: acceptance weights on filters, exact deferred-order
// emission in the driver, the graded {edit:…} form and the soft {~…}
// constructs.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SessionContext } from "../src/session-context.js";
import { compileConjuncts, compileQuery, makeDriver } from "../src/find-expr.js";
import { makeFilter } from "../src/expr-filter.js";
import { GRADED_EDIT_DAMAGE } from "../src/value-constraint.js";
import { SOFT_PENALTY } from "../src/construct-table.js";

const ctx = new SessionContext();

/** The filter's acceptance weight for this exact string, or null if rejected. */
function weightOf(query: string, text: string): number | null {
  const filter = makeFilter(compileConjuncts(query, ctx));
  let state = filter.startState;
  for (let i = 0; i < text.length; ++i) {
    state = filter.transition(state, text.charCodeAt(i));
    if (state < 0) return null;
  }
  if (!filter.isAccepting(state)) return null;
  return filter.acceptWeight === undefined ? 1 : filter.acceptWeight(state);
}

describe("acceptance weights", () => {
  it("stay absent on ordinary filters — the fast path", () => {
    const filter = makeFilter(compileConjuncts("A{5}", ctx));
    expect(filter.acceptWeight).toBeUndefined();
  });

  it("grade the {edit:…} form by damage", () => {
    expect(weightOf("{edit:gamma}", "gamma ")).toBe(1);
    expect(weightOf("{edit:gamma}", "gamm ")).toBe(GRADED_EDIT_DAMAGE);
    expect(weightOf("{edit:gamma}", "gamqq ")).toBe(GRADED_EDIT_DAMAGE ** 2);
  });

  it("boost members of a soft list and penalize everything else", () => {
    expect(weightOf("{~list:alpha,beta}", "alpha ")).toBe(1);
    expect(weightOf("{~list:alpha,beta}", "dog ")).toBe(SOFT_PENALTY);
  });

  it("carry through an intersection product", () => {
    expect(weightOf("A{5}&{~list:alpha,gamma}", "gamma ")).toBe(1);
    expect(weightOf("A{5}&{~list:alpha,gamma}", "quick ")).toBe(SOFT_PENALTY);
    // The hard side still rejects outright.
    expect(weightOf("A{5}&{~list:alpha,gamma}", "dog ")).toBeNull();
  });
});

describe("weighted constructs are conjunct-level", () => {
  const throws = (q: string) =>
    expect(() => compileQuery(q, ctx), q).toThrow(/joins the query with "&"/);

  it("refuse groups, concatenation and quantifiers", () => {
    throws("({~list:a,b})x");
    throws("x{edit:beast}");
    throws("({~list:a,b}|A{3})");
    throws("{edit:beast}?");
  });

  it("stand alone and intersect", () => {
    expect(() => compileQuery("{~list:alpha,beta}", ctx)).not.toThrow();
    expect(() => compileQuery("A{5}&{edit:gamma}", ctx)).not.toThrow();
  });
});

describe("the driver emits weighted results in true score order", () => {
  it("streams exact matches before damaged ones, descending throughout", async () => {
    const data = fs.readFileSync("test/fixtures/nutrimatic-bigger.index");
    const reader = await IndexReader.open(new MemorySource(data));
    const driver = makeDriver(reader, compileQuery("{edit:dog}", ctx));
    const results: Array<{ text: string; score: number }> = [];
    for (let steps = 0; steps < 400000 && results.length < 30; ++steps) {
      let r = driver.step();
      if (r instanceof Promise) r = await r;
      if (r) {
        if (driver.text === null) break;
        results.push({ text: driver.text.trim(), score: driver.score });
      }
    }
    expect(results.length).toBeGreaterThan(1);
    expect(results[0].text).toBe("dog");
    for (let i = 1; i < results.length; ++i) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
    // Everything after the exact match carries real damage.
    for (const r of results.slice(1)) {
      expect(r.score).toBeLessThanOrEqual(results[0].score * GRADED_EDIT_DAMAGE);
    }
  });
});
