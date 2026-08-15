// WasmSession vs SearchSession parity: identical score-streams on the same
// index, engine reuse across queries (heap checkpoint/reset), and resumable
// run() semantics — the contract the worker's fallback replay relies on.

import * as fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { ParseError } from "../src/find-expr.js";
import { SearchSession } from "../src/search-session.js";
import { WasmEngine, WasmSession } from "../src/wasm-session.js";

const INDEX = "web/public/demo.index";
const KERNEL = "wasm-kernel/kernel.wasm";
const BUDGET = 200000;
const MAX_RESULTS = 100;

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

async function jsResults(query: string): Promise<Array<[string, number]>> {
  const session = new SearchSession(reader, query);
  const out: Array<[string, number]> = [];
  await session.run(BUDGET, MAX_RESULTS, (r) => out.push([r.text, r.score]));
  return out;
}

async function wasmResults(query: string): Promise<Array<[string, number]>> {
  const session = new WasmSession(engine, query);
  const out: Array<[string, number]> = [];
  await session.run(BUDGET, MAX_RESULTS, (r) => out.push([r.text, r.score]));
  return out;
}

describe("WasmSession parity", () => {
  // Sequential queries on ONE engine also exercise the per-query heap reset.
  const QUERIES = [
    "n[aeiou]tr[aeiou]m_tic",
    "<aaagmnr>",
    "solar s_stem",
    '"C*aC*eC*i"',
    "867-####",
    // Value constraints are ordinary conjunct NFAs, so the kernel gets them
    // with no C-side work — this locks that in.
    "{sum=52:A*}",
    "{scrabble>25:A{5}}",
    "{sum=50..60:A{4}}&C*",
    "{count(e)=2:A*}",
    "{distinct:A{6}}", // 26 conjuncts, just under the kernel's MAX_CONJ
    "<<washington>>",
    "{edit<=1:cargo}",
    "{caesar:kdhv}",
    "{t9:2665}",
    "{ascending:A{5}}",
  ];

  for (const q of QUERIES) {
    it(`matches the JS engine on ${JSON.stringify(q)}`, async () => {
      const js = await jsResults(q);
      const wasm = await wasmResults(q);
      // Equal-scored results may emit in either order (both are valid
      // priority-queue behavior): the score sequences must match exactly.
      expect(wasm.map(([, s]) => s)).toEqual(js.map(([, s]) => s));
      expect(new Set(wasm.map(([t]) => t))).toEqual(new Set(js.map(([t]) => t)));
    });
  }

  it("throws ParseError like the JS engine", () => {
    expect(() => new WasmSession(engine, "([broken")).toThrow(ParseError);
  });

  it("resumes with a raised step budget (try harder)", async () => {
    const session = new WasmSession(engine, "<aaagmnr>");
    const first: string[] = [];
    const status = await session.run(1000, MAX_RESULTS, (r) => first.push(r.text));
    expect(status).toBe("limit");
    expect(session.steps).toBe(1000);
    const more: string[] = [];
    await session.run(BUDGET, MAX_RESULTS, (r) => more.push(r.text));
    // maxResults is a per-run() budget, so the resumed session may collect a
    // few more results in total; its stream must be a superset-prefix match
    // of a fresh full run.
    const full = (await wasmResults("<aaagmnr>")).map(([t]) => t);
    expect([...first, ...more].slice(0, full.length)).toEqual(full);
  });

  it("a superseded session can never step the re-seeded kernel", async () => {
    // Two sessions share one engine; creating the second re-seeds the
    // kernel, so the first must refuse to run (the worker relies on this to
    // keep a stale parked run from corrupting the new query's stream).
    const first = new WasmSession(engine, "<aaagmnr>");
    const got: string[] = [];
    await first.run(500, 5, (r) => got.push(r.text));
    const second = new WasmSession(engine, "solar s_stem");
    await expect(first.run(BUDGET, 5, () => {})).rejects.toThrow(/superseded/);
    // The new owner is unaffected.
    const out: string[] = [];
    await second.run(BUDGET, 5, (r) => out.push(r.text));
    expect(out[0]).toBe("solar system");
  });

  it("reports progress and honors the yield callback", async () => {
    // A 16-letter anagram reliably runs the whole budget on the demo index.
    const session = new WasmSession(engine, "<aaeeiimnnorsttu>");
    let progress = 0;
    let yields = 0;
    const status = await session.run(
      BUDGET,
      MAX_RESULTS,
      () => {},
      () => ++progress,
      () => {
        ++yields;
      },
    );
    expect(status).toBe("limit");
    expect(session.steps).toBe(BUDGET);
    expect(progress).toBeGreaterThan(0); // fires at 100k-step boundaries
    expect(yields).toBeGreaterThan(0); // fires every ~20k steps
  });
});
