// What a search cost.
//
// The numbers are collected from the components that already keep them rather
// than accumulated into an object threaded through the walk, so these tests
// are mostly about the collection being wired to the right places — a counter
// reading zero forever looks exactly like a cheap query.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { BufferSink, IndexWriter, writeEntries } from "../src/index-writer.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";
import { emptyStats, formatBytes, formatStats } from "../src/stats.js";

const ctx = new SessionContext();

async function demoReader() {
  const data = fs.readFileSync(new URL("../web/public/demo.index", import.meta.url));
  return IndexReader.open(new MemorySource(data));
}

describe("collecting", () => {
  it("counts the work a real search did", async () => {
    const session = new SearchSession(await demoReader(), "A{5}", ctx);
    await session.run(20000, 10, () => {});
    const s = session.stats();
    expect(s.steps).toBeGreaterThan(0);
    expect(s.results).toBe(10);
    // The frontier is at least as big as the work done to fill it.
    expect(s.frontierPeak).toBeGreaterThan(0);
    // Even a plain pattern builds a few lazy DFA states.
    expect(s.dfaStates).toBeGreaterThan(0);
  });

  it("reports a memory source as fetching nothing", async () => {
    const session = new SearchSession(await demoReader(), "A{4}", ctx);
    await session.run(5000, 5, () => {});
    const s = session.stats();
    expect(s.bytesFetched).toBe(0);
    expect(s.requests).toBe(0);
  });

  it("grows the DFA more for an anagram than for a literal", async () => {
    // The counter is meant to explain why one query is slow and another is
    // not, so it has to move with the thing it is measuring.
    const plain = new SearchSession(await demoReader(), "solar s_stem", ctx);
    await plain.run(20000, 5, () => {});
    const anagram = new SearchSession(await demoReader(), "<aciimnrttu>", ctx);
    await anagram.run(20000, 5, () => {});
    expect(anagram.stats().dfaStates).toBeGreaterThan(plain.stats().dfaStates);
  });

  it("keeps counting across a resumed run", async () => {
    const session = new SearchSession(await demoReader(), "A{5}", ctx);
    await session.run(3000, 3, () => {});
    const first = session.stats();
    await session.run(9000, 3, () => {});
    const second = session.stats();
    expect(second.steps).toBeGreaterThan(first.steps);
    expect(second.results).toBeGreaterThan(first.results);
  });

  it("reports predicate outcomes the caller records", async () => {
    const session = new SearchSession(await demoReader(), "A{5}", ctx);
    await session.run(3000, 3, () => {});
    session.predicateChecks = 100;
    session.predicatePassed = 7;
    expect(session.stats().predicateChecks).toBe(100);
    expect(session.stats().predicatePassed).toBe(7);
  });

  it("counts nothing before the search runs", async () => {
    const sink = new BufferSink();
    writeEntries(new IndexWriter(sink), [["cat ", 5]]);
    const reader = await IndexReader.open(new MemorySource(sink.bytes()));
    const session = new SearchSession(reader, "A{3}", ctx);
    expect(session.stats().steps).toBe(0);
    expect(session.stats().results).toBe(0);
  });
});

describe("formatting", () => {
  it("scales byte counts to something readable", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1048576)).toBe("5.0 MB");
    expect(formatBytes(2 * 1073741824)).toBe("2.00 GB");
  });

  it("drops the numbers with nothing to say", () => {
    // Ten zeros would bury the two lines that matter on an in-memory search.
    const lines = formatStats({ ...emptyStats(), steps: 5, results: 1 });
    expect(lines).toEqual(["steps: 5", "results: 1"]);
  });

  it("reports the cache ratio, which is the number that matters in range mode", () => {
    const lines = formatStats({
      ...emptyStats(),
      chunkHits: 30,
      chunkMisses: 10,
    });
    expect(lines.join("\n")).toContain("30/40 hits (75%)");
  });

  it("reports fetches together, since neither alone is meaningful", () => {
    const lines = formatStats({
      ...emptyStats(),
      bytesFetched: 3 * 1048576,
      requests: 12,
    });
    expect(lines.join("\n")).toContain("3.0 MB in 12 requests");
  });
});
