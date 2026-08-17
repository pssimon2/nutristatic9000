// A chunk a caller is waiting on must not be evicted before it can read it.
//
// CI caught this as `byte 14991360 not ensured` from the range test, which
// passes locally every time — a slower machine simply interleaves differently.
// The read after ensure() is *synchronous* (the search loop cannot await
// per byte), so if a speculative prefetch completes in between and pushes the
// cache over its limit, the LRU can drop the very chunk that read needs and
// there is no way to recover.
//
// The scenario is only reachable when the cache is small relative to the
// read-ahead, which is exactly the case on a big index over a slow link.

import { describe, expect, it } from "vitest";
import { HttpRangeSource } from "../src/byte-source.js";

const LENGTH = 1 << 16; // 64 KB
const CHUNK = 1 << 10; // 1 KB, so 64 chunks in the file

/** Serves the file's bytes, with each chunk's value equal to its index. */
function fakeFetch(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range ?? "";
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (!m) {
      return new Response(new Uint8Array(0), {
        status: 200,
        headers: { "content-length": String(LENGTH) },
      });
    }
    const from = Number(m[1]);
    const to = Math.min(Number(m[2]), LENGTH - 1);
    const body = new Uint8Array(to - from + 1);
    for (let i = 0; i < body.length; ++i) {
      body[i] = Math.floor((from + i) / CHUNK) & 0xff;
    }
    return new Response(body, {
      status: 206,
      headers: {
        "content-range": `bytes ${from}-${to}/${LENGTH}`,
        "content-length": String(body.length),
      },
    });
  }) as unknown as typeof fetch;
}

async function source() {
  return HttpRangeSource.open("http://example.invalid/i.index", {
    chunkSize: CHUNK,
    maxChunks: 4, // far smaller than the read-ahead below
    fetchFn: fakeFetch(),
    known: { length: LENGTH, supportsRanges: true },
  });
}

describe("a promised chunk survives a concurrent prefetch", () => {
  it("reads the byte ensure() promised, after prefetching past the cache size", async () => {
    const src = await source();
    // The caller asks for one chunk and, as the search loop does, reads it
    // synchronously once the promise settles.
    const promise = src.ensure(0, 16);
    // Meanwhile the driver speculates far ahead — more chunks than the cache
    // can hold, which is what makes eviction fire.
    for (let c = 10; c < 40; ++c) src.prefetchHint?.(c * CHUNK, c * CHUNK + 16);
    await promise;
    // Before the fix this threw "byte 0 not ensured".
    expect(src.byte(0)).toBe(0);
  });

  it("keeps the whole promised span, not just its first chunk", async () => {
    const src = await source();
    const promise = src.ensure(0, 3 * CHUNK);
    for (let c = 20; c < 50; ++c) src.prefetchHint?.(c * CHUNK, c * CHUNK + 16);
    await promise;
    for (let c = 0; c < 3; ++c) expect(src.byte(c * CHUNK), `chunk ${c}`).toBe(c);
  });

  it("holds several pins at once — the case a one-span pin loses", async () => {
    const src = await source();
    // Two reads pending at once, each pinning its own span. The one-span pin
    // was overwritten by whichever ensure ran last, so the first read's
    // chunks were fair game for eviction while it awaited.
    const pinA = src.pin!(0, 16);
    const a = src.ensure(0, 16);
    const pinB = src.pin!(30 * CHUNK, 30 * CHUNK + 16);
    const b = src.ensure(30 * CHUNK, 30 * CHUNK + 16);
    // Heavy unrelated traffic while both are pending.
    for (let c = 40; c < 60; ++c) {
      const p = src.ensure(c * CHUNK, c * CHUNK + 16);
      if (p) await p;
    }
    await Promise.all([a, b]);
    expect(src.byte(0)).toBe(0);
    expect(src.byte(30 * CHUNK)).toBe(30 & 0xff);
    src.unpin!(pinA);
    src.unpin!(pinB);
    // Released, the spans are ordinary LRU citizens again — fresh fetches
    // (chunks the cache has never held, so real inserts fire the evictor)
    // push them out.
    for (let c = 10; c < 30; ++c) {
      const p = src.ensure(c * CHUNK, c * CHUNK + 16);
      if (p) await p;
    }
    expect(() => src.byte(0)).toThrow(/not ensured/);
  });

  it("still evicts, or the cache would grow without bound", async () => {
    const src = await source();
    // Sequential reads: each ensure releases the previous pin.
    for (let c = 0; c < 40; ++c) {
      const p = src.ensure(c * CHUNK, c * CHUNK + 16);
      if (p) await p;
      expect(src.byte(c * CHUNK)).toBe(c);
    }
    // An early chunk should be long gone from a four-chunk cache.
    expect(() => src.byte(0)).toThrow(/not ensured/);
  });
});
