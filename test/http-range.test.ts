// Integration test for range-request mode: serve the demo index over a
// local HTTP server that honors Range headers, and verify a search via
// HttpRangeSource returns exactly what the in-memory source returns.

import * as fs from "node:fs";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpRangeSource, MemorySource } from "../src/byte-source.js";
import { CompressedRangeSource } from "../src/compressed-source.js";
import { buildIdxz } from "../src/idxz-build.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession, SearchResult } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";
import { probeCount } from "../src/index-probe.js";

const ctx = new SessionContext();

const INDEX_PATH = new URL("../web/public/demo.index", import.meta.url)
  .pathname;

let server: http.Server;
let baseUrl: string;
const data = fs.readFileSync(INDEX_PATH);
const sidecar = buildIdxz(data);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = req.url?.endsWith(".idxz") ? sidecar : data;
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = parseInt(range[1], 10);
      const end = Math.min(parseInt(range[2], 10), body.length - 1);
      res.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "content-length": end - start + 1,
      });
      res.end(body.subarray(start, end + 1));
    } else {
      res.writeHead(200, { "content-length": body.length });
      res.end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function collect(
  reader: IndexReader,
  query: string,
  maxSteps: number,
  prefetchDepth = 0,
): Promise<SearchResult[]> {
  const session = new SearchSession(reader, query, ctx, undefined, { prefetchDepth });
  const results: SearchResult[] = [];
  await session.run(maxSteps, 50, (r) => results.push(r));
  return results;
}

describe("HttpRangeSource", () => {
  it("reports the file length from a range probe", async () => {
    const source = await HttpRangeSource.open(`${baseUrl}/demo.index`);
    expect(source.length).toBe(data.length);
  });

  it("search over ranges matches search over memory", async () => {
    const memReader = await IndexReader.open(new MemorySource(data));
    const source = await HttpRangeSource.open(`${baseUrl}/demo.index`, {
      chunkSize: 1 << 14,
      maxChunks: 64, // force LRU eviction
    });
    const rangeReader = await IndexReader.open(source);

    expect(rangeReader.count()).toBe(memReader.count());

    const memResults = await collect(memReader, "n[aeiou]tr[aeiou]m_tic", 200000);
    // prefetchDepth exercises speculative fetches + in-flight dedupe.
    const rangeResults = await collect(
      rangeReader,
      "n[aeiou]tr[aeiou]m_tic",
      200000,
      6,
    );
    expect(rangeResults).toEqual(memResults);
    expect(source.requests).toBeGreaterThan(0);
  }, 60000);

  it("compressed sidecar source matches memory search at ~half the bytes", async () => {
    const memReader = await IndexReader.open(new MemorySource(data));
    const source = await CompressedRangeSource.open(
      `${baseUrl}/demo.index`,
      data.length,
    );
    expect(source).not.toBeNull();
    expect(source!.length).toBe(data.length);
    const reader = await IndexReader.open(source!);
    expect(reader.count()).toBe(memReader.count());

    const memResults = await collect(memReader, "n[aeiou]tr[aeiou]m_tic", 200000);
    const zResults = await collect(reader, "n[aeiou]tr[aeiou]m_tic", 200000, 6);
    expect(zResults).toEqual(memResults);
    // The whole point: compressed transfer should be well under the
    // uncompressed volume for the same walk.
    expect(source!.ratio).toBeLessThan(0.8);
    expect(source!.bytesFetched).toBeLessThan(data.length);
  }, 60000);

  it("sidecar open returns null for a stale or missing sidecar", async () => {
    // Wrong expected size => treated as stale.
    expect(
      await CompressedRangeSource.open(`${baseUrl}/demo.index`, data.length + 1),
    ).toBeNull();
  });

  it("fetches a bounded volume with a realistic cache", async () => {
    const source = await HttpRangeSource.open(`${baseUrl}/demo.index`);
    const reader = await IndexReader.open(source);
    const results = await collect(reader, "n[aeiou]tr[aeiou]m_tic", 200000);
    expect(results.length).toBeGreaterThan(0);
    // Over loopback the measured RTT/bandwidth make the adaptive read-ahead
    // legitimately aggressive, so only assert we don't grossly re-fetch.
    expect(source.bytesFetched).toBeLessThan(data.length * 1.5);
  }, 60000);
});

// One query is not a differential.
//
// Both source-vs-memory checks above use `n[aeiou]tr[aeiou]m_tic` and nothing
// else, which pins one traversal shape: a narrow pattern walking a few deep
// paths. The sources differ in *where they cut the file up* — chunk
// boundaries, block boundaries, what gets evicted, what a read-ahead brings in
// speculatively — and which of those bite depends entirely on where the walk
// goes. A phrase query restarting at word boundaries, an anagram fanning out
// across the trie, and a counter pruning hard all stress different parts of
// that, and none of them were covered.
//
// Small caches on purpose: the interesting failures are eviction ones, and a
// cache that holds everything never evicts.
describe("every source returns the same results", () => {
  // Enough steps to reach the interesting part of each traversal, not enough
  // to spend three minutes proving it: every read here is an HTTP round trip
  // against a deliberately undersized cache.
  const STEPS = 9000;
  // One per traversal shape rather than one per construct: what differs
  // between the sources is where the walk goes, not what the pattern means.
  // `n[aeiou]tr[aeiou]m_tic` is deliberately absent — the two tests above
  // already run exactly that.
  const QUERIES = [
    "solar s_stem", // restarts at word boundaries
    "<aaagmnr>", // fans out across the trie
    "A{5}&C*", // wide, shallow, product filter
    "nutr*", // one deep path, then restarts off it
    "A{4} A{5}", // two words, so two restarts deep
    '"C*aC*eC*i"', // quoted: no restarts at all
    "{distinct:A{6}}", // 26 conjuncts, heavy lazy-DFA growth
  ];

  for (const query of QUERIES) {
    it(`agrees on ${query}`, async () => {
      const memory = await collect(
        await IndexReader.open(new MemorySource(data)),
        query,
        STEPS,
      );
      expect(memory.length, "nothing to compare").toBeGreaterThan(0);

      const ranged = await HttpRangeSource.open(`${baseUrl}/demo.index`, {
        chunkSize: 1 << 14,
        maxChunks: 160, // evicts steadily over a 20 MB index without refetching everything
      });
      expect(
        await collect(await IndexReader.open(ranged), query, STEPS, 6),
        `${query}: range source disagrees with memory`,
      ).toEqual(memory);

      const compressed = await CompressedRangeSource.open(
        `${baseUrl}/demo.index`,
        data.length,
        { maxBlocks: 320 },
      );
      expect(compressed).not.toBeNull();
      expect(
        await collect(await IndexReader.open(compressed!), query, STEPS, 6),
        `${query}: compressed sidecar disagrees with memory`,
      ).toEqual(memory);
    }, 60000);
  }
});

describe("the block cache floor", () => {
  it("cannot be configured below what the fetches need", async () => {
    // A cache of 8 or 16 blocks made `A{5}&C*` die with "byte … not ensured",
    // in about three runs in five. Tracing it showed a block evicted while a
    // read of it was pending, because the single pin span had been overwritten
    // by a later ensure — see MIN_CACHE_BLOCKS. Nothing real asks for a cache
    // that small (the default is 4096), so the floor keeps the race out of
    // reach; fixing it properly needs a pin several readers can hold.
    const source = await CompressedRangeSource.open(
      `${baseUrl}/demo.index`,
      data.length,
      { maxBlocks: 8 },
    );
    expect(source).not.toBeNull();
    const results = await collect(
      await IndexReader.open(source!),
      "A{5}&C*",
      200000,
      6,
    );
    const memory = await collect(
      await IndexReader.open(new MemorySource(data)),
      "A{5}&C*",
      200000,
    );
    expect(results).toEqual(memory);
  }, 60000);
});

// The score probe over a streamed index.
//
// A probe is a single path down the trie, so it should cost round trips
// proportional to the word's length rather than to the index's size — that is
// the whole reason it exists as something separate from a search. Over a
// memory source the distinction is invisible, so it has to be checked here.
describe("probing a streamed index", () => {
  it("gives the same counts as the same index in memory", async () => {
    const memory = await IndexReader.open(new MemorySource(data));
    const source = await HttpRangeSource.open(`${baseUrl}/demo.index`);
    const streamed = await IndexReader.open(source);
    for (const word of ["the", "chicken", "solar system", "blasphemer", "qqzzxxjjv"]) {
      expect(await probeCount(streamed, word), word).toBe(
        await probeCount(memory, word),
      );
    }
  }, 60000);

  it("costs round trips proportional to the word, not to the index", async () => {
    const source = await HttpRangeSource.open(`${baseUrl}/demo.index`);
    const streamed = await IndexReader.open(source);
    const before = source.requests;
    await probeCount(streamed, "chicken");
    const requests = source.requests - before;

    // "chicken " is eight levels, so eight child lookups at most, and
    // read-ahead means several of them land in bytes already fetched. The
    // claim being pinned is that this is bounded by the word rather than by
    // the index: a number in single figures, not the hundreds a walk makes.
    expect(requests).toBeGreaterThan(0);
    expect(requests, `${requests} requests for one eight-character probe`)
      .toBeLessThanOrEqual(8);
  }, 60000);
});
