// The two engines, told to disagree.
//
// `WasmSession` and `SearchSession` are independent implementations of the
// same search — one in C compiled to WASM, one in TypeScript — reading the
// same index with the same conjunct NFAs. That makes them each other's oracle:
// there is no fixture saying what `(a|b)C{2}&_{3}` ought to return on this
// corpus, but there is no world in which the right answer differs between
// them. A disagreement is a bug in one of the two, always.
//
// The existing parity test names eighteen queries by hand, which pins the
// shapes someone thought of. This generates them instead, from the grammar,
// so it covers combinations nobody wrote down — nested quantifiers inside
// alternations inside intersections, anagrams beside classes, a construct
// crossed with a literal.
//
// Seeded, so a failure names the query and the seed that produced it and can
// be replayed exactly. Deliberately excluded: negation, which the kernel hands
// to the JS engine when it will not build (`WasmUnsupportedError`), so the two
// are *meant* to differ in which engine runs — that path has its own tests.

import * as fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
import { WasmEngine, WasmSession } from "../src/wasm-session.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();
const INDEX = "web/public/demo.index";
const KERNEL = "wasm-kernel/kernel.wasm";
// Small on purpose: a hundred random queries at a large budget is a slow test
// nobody runs, and disagreement between two implementations shows up in the
// first results far more often than in the thousandth.
const BUDGET = 20000;
const MAX_RESULTS = 20;

let reader: IndexReader;
let engine: WasmEngine;

beforeAll(async () => {
  const data = fs.readFileSync(INDEX);
  reader = await IndexReader.open(new MemorySource(data));
  const module = await WebAssembly.compile(fs.readFileSync(KERNEL));
  engine = await WasmEngine.create(module, data.length, reader.count(), (t) =>
    t.set(data),
  );
});

/** Deterministic PRNG (mulberry32), so a failing case is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random query, biased towards the shapes a person types: mostly short,
 * mostly anchored by a class or a literal, occasionally intersected.
 */
function randomQuery(rand: () => number): string {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const letters = "abcdeilnorst"; // common enough to actually match something

  const atom = (): string => {
    switch (pick(["lit", "lit", "class", "class", "set", "group"])) {
      case "lit":
        return pick([...letters]);
      case "class":
        return pick(["A", "C", "V", "#", "_", "."]);
      case "set":
        return `[${pick(["aeiou", "abc", "rst", "xyz", "ei"])}]`;
      default:
        return `(${branch(1)})`;
    }
  };

  const piece = (depth: number): string => {
    const a = depth > 1 ? atom() : pick([...letters, "A", "C", "V"]);
    switch (pick(["", "", "", "?", "*", "+", "{n}", "{n,m}"])) {
      case "?":
        return `${a}?`;
      case "*":
        return `${a}*`;
      case "+":
        return `${a}+`;
      case "{n}":
        return `${a}{${1 + Math.floor(rand() * 3)}}`;
      case "{n,m}": {
        const lo = 1 + Math.floor(rand() * 2);
        return `${a}{${lo},${lo + 1 + Math.floor(rand() * 2)}}`;
      }
      default:
        return a;
    }
  };

  const branch = (depth: number): string => {
    const n = 1 + Math.floor(rand() * 3);
    const parts = Array.from({ length: n }, () => piece(depth));
    const joined = parts.join("");
    return rand() < 0.25 ? `${joined}|${piece(depth)}` : joined;
  };

  const factor = (): string => {
    if (rand() < 0.12) {
      // An anagram of a few letters: a very different shape to a trie walk.
      const n = 3 + Math.floor(rand() * 3);
      return `<${Array.from({ length: n }, () => pick([...letters])).join("")}>`;
    }
    if (rand() < 0.12) {
      return pick([
        `{sum=${20 + Math.floor(rand() * 60)}:A*}`,
        `{count(e)=${1 + Math.floor(rand() * 2)}:A*}`,
        `{distinct:A{${3 + Math.floor(rand() * 2)}}}`,
        `{maxrep=${1 + Math.floor(rand() * 2)}:A{4}}`,
        `{letters=${3 + Math.floor(rand() * 4)}:A*}`,
      ]);
    }
    return branch(0);
  };

  const n = rand() < 0.35 ? 2 : 1;
  return Array.from({ length: n }, factor).join("&");
}

interface Run {
  scores: number[];
  texts: Set<string>;
}

async function runJs(query: string): Promise<Run> {
  const s = new SearchSession(reader, query, ctx);
  const scores: number[] = [];
  const texts = new Set<string>();
  await s.run(BUDGET, MAX_RESULTS, (r) => {
    scores.push(r.score);
    texts.add(r.text);
  });
  return { scores, texts };
}

async function runWasm(query: string): Promise<Run> {
  const s = new WasmSession(engine, query, ctx);
  const scores: number[] = [];
  const texts = new Set<string>();
  await s.run(BUDGET, MAX_RESULTS, (r) => {
    scores.push(r.score);
    texts.add(r.text);
  });
  return { scores, texts };
}

describe("the two engines agree on random queries", () => {
  // One `it` per batch rather than per query: 120 test names of generated
  // gibberish is not a readable report, and the assertion message carries the
  // query that actually failed.
  for (const seed of [1, 2, 3, 4]) {
    it(`agrees on 30 queries from seed ${seed}`, async () => {
      const rand = rng(seed);
      let compared = 0;
      for (let i = 0; i < 30; ++i) {
        const query = randomQuery(rand);
        let js: Run;
        try {
          js = await runJs(query);
        } catch {
          continue; // not a valid query, or too complex: not what this tests
        }
        let wasm: Run;
        try {
          wasm = await runWasm(query);
        } catch {
          continue; // kernel declined it (capacity, unsupported): its own tests
        }
        ++compared;
        // Equal-scored results may emit in either order — both are valid
        // priority-queue behaviour — so the score sequence is the strict
        // comparison and the texts are compared as a set.
        expect(wasm.scores, `${query} (seed ${seed})`).toEqual(js.scores);
        expect(wasm.texts, `${query} (seed ${seed})`).toEqual(js.texts);
      }
      // A generator that mostly produced unparseable junk would pass this
      // whole file while testing nothing.
      expect(compared, "queries actually compared").toBeGreaterThan(20);
    });
  }
});

// The bug the generator above found, kept as a named case.
//
// `expand()` reported a match by returning, and the restart that continues a
// phrase past a word boundary sat *below* that return. So a node that was both
// accepting and a space ended the phrase there: `e{2}a?` reported "ee" and
// never looked at "ee a", while `e{2}a` — not accepting at "ee ", so falling
// through — found it. Making a term optional cannot remove matches, and this
// did.
//
// It hid behind the duplicate check: a match reachable a second way reached
// the restart on that second visit, so the results were wrong in a way that
// depended on how many paths led to them. The kernel, which has no such check,
// lost strictly more.
describe("a match that is also a word boundary", () => {
  it("continues the phrase instead of stopping at the match", async () => {
    const { texts } = await runJs("e{2}a?");
    expect([...texts]).toContain("ee a");
  });

  it("both engines agree on it", async () => {
    const js = await runJs("e{2}a?");
    const wasm = await runWasm("e{2}a?");
    expect(wasm.texts).toEqual(js.texts);
    expect(wasm.scores).toEqual(js.scores);
  });

  it("making a term optional never loses a match", async () => {
    // The general invariant: L(x) is a subset of L(x?), so every result of the
    // mandatory form must appear in the optional one. This is what the
    // specific case above is an instance of.
    for (const [strict, loose] of [
      ["e{2}a", "e{2}a?"],
      ["ee a", "ee a?"],
      ["e{2}i", "e{2}i?"],
    ]) {
      const from = await runJs(strict);
      const to = await runJs(loose);
      for (const t of from.texts) {
        expect([...to.texts], `${loose} lost "${t}" that ${strict} found`)
          .toContain(t);
      }
    }
  });
});
