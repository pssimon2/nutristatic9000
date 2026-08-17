// The conjunct-filter cache: the same conjunct gets the same lazy DFA
// back, and reusing one cannot change what a search answers.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SessionContext } from "../src/session-context.js";
import { compileConjuncts, makeDriver } from "../src/find-expr.js";
import {
  FilterCache,
  fingerprintConjunct,
  makeFilter,
} from "../src/expr-filter.js";

const ctx = new SessionContext();

describe("fingerprintConjunct", () => {
  it("is stable across parses of the same fragment", () => {
    const a = compileConjuncts("<aaagmnr>&A*", ctx).map(fingerprintConjunct);
    const b = compileConjuncts("<aaagmnr>&A*", ctx).map(fingerprintConjunct);
    expect(a).toEqual(b);
  });

  it("separates different fragments and negation", () => {
    const [plain] = compileConjuncts("A{4}", ctx).map(fingerprintConjunct);
    const [other] = compileConjuncts("A{5}", ctx).map(fingerprintConjunct);
    const [negated] = compileConjuncts("!A{4}", ctx).map(fingerprintConjunct);
    expect(plain).not.toBe(other);
    expect(plain).not.toBe(negated);
    expect(negated.startsWith("!")).toBe(true);
  });
});

describe("FilterCache", () => {
  it("returns the same filter for the same conjunct, warm tables and all", () => {
    const cache = new FilterCache();
    const [first] = compileConjuncts("<aaagmnr>", ctx);
    const a = cache.filterFor(first);
    const [again] = compileConjuncts("<aaagmnr>", ctx);
    expect(cache.filterFor(again)).toBe(a);
  });

  it("evicts least-recently-used beyond its limit", () => {
    const cache = new FilterCache(2);
    const one = cache.filterFor(compileConjuncts("A{1}", ctx)[0]);
    cache.filterFor(compileConjuncts("A{2}", ctx)[0]);
    cache.filterFor(compileConjuncts("A{3}", ctx)[0]); // evicts A{1}
    expect(cache.filterFor(compileConjuncts("A{1}", ctx)[0])).not.toBe(one);
  });

  it("does not change what a search answers", async () => {
    const data = fs.readFileSync("test/fixtures/upstream-bigger.index");
    const run = async (query: string, cache?: FilterCache) => {
      const reader = await IndexReader.open(new MemorySource(data));
      const driver = makeDriver(
        reader,
        makeFilter(compileConjuncts(query, ctx), cache),
      );
      const out: string[] = [];
      for (let steps = 0; steps < 100000 && out.length < 25; ++steps) {
        let r = driver.step();
        if (r instanceof Promise) r = await r;
        if (r) {
          if (driver.text === null) break;
          out.push(`${driver.score} ${driver.text}`);
        }
      }
      return out;
    };
    const cache = new FilterCache();
    const cold = await run("<abginr>&A*", cache);
    // Second run through the same cache: the anagram filter arrives warm.
    const warm = await run("<abginr>&A*", cache);
    const plain = await run("<abginr>&A*");
    expect(warm).toEqual(plain);
    expect(cold).toEqual(plain);
  });
});
