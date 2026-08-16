// Choosing and validating where index bytes come from: the page's early
// probe, the whole-copy cache, and the persistent range-chunk store.
//
// The decisions here are cheap to get subtly wrong and expensive to notice —
// misreading a probe opens the index at the wrong length, and a mishandled
// validator either serves bytes from a stale rebuild or throws away a good
// 1.3 GB copy. The parsing is pure and separated from the Cache API use so it
// can be tested directly.

import { ChunkStore, validatorFrom } from "../../src/byte-source.js";
import { openCache } from "./net.js";
import type { EarlyProbe } from "./protocol.js";

export const CACHE_NAME = "nutrimatic-index-v1";
// Chunk keys include the chunk size, so entries cached under a different
// chunking are never reinterpreted.
export const CHUNK_CACHE_NAME = "nutrimatic-chunks-v2";
export const RANGE_CHUNK_SIZE = 1 << 15;

/** Header a cached whole copy carries so it can be revalidated later. */
export const VALIDATOR_HEADER = "x-nutrimatic-validator";

export interface ProbeResult {
  length: number;
  supportsRanges: boolean;
  validator: string | null;
}

/**
 * Interpret an early page-side probe response (same logic as the source).
 * Null means "inconclusive — do a real probe".
 */
export function parseEarlyProbe(probe: EarlyProbe): ProbeResult | null {
  if (!probe.ok) return null;
  const validator = validatorFrom(probe.etag, probe.lastModified);
  if (probe.status === 206) {
    const m = probe.contentRange && /\/(\d+)\s*$/.exec(probe.contentRange);
    if (m) return { length: parseInt(m[1], 10), supportsRanges: true, validator };
    // A 206 whose total we can't parse (e.g. "bytes 0-0/*") must NOT fall
    // through to Content-Length — that's the 1-byte range's length, and the
    // index would open as a 1-byte file. Force a real probe instead.
    return null;
  }
  if (probe.contentLength) {
    return {
      length: parseInt(probe.contentLength, 10),
      supportsRanges: false,
      validator,
    };
  }
  return null;
}

/** True when a cached full copy's validator contradicts the live probe's. */
export function cachedCopyStale(
  hit: Response,
  currentValidator: string | null,
): boolean {
  const stored = hit.headers.get(VALIDATOR_HEADER);
  return stored !== null && currentValidator !== null && stored !== currentValidator;
}

/** Persists range chunks so repeat queries and visits reuse them. */
export class CacheChunkStore implements ChunkStore {
  private readonly cachePromise = openCache(CHUNK_CACHE_NAME);
  constructor(
    private readonly url: string,
    private readonly chunkSize: number,
  ) {}

  private key(chunk: number): string {
    return `${this.url}?nutrimatic-chunk=${this.chunkSize}-${chunk}`;
  }

  async get(chunk: number): Promise<Uint8Array | undefined> {
    try {
      const cache = await this.cachePromise;
      const hit = cache && (await cache.match(this.key(chunk)));
      return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
    } catch {
      return undefined;
    }
  }

  put(chunk: number, data: Uint8Array): void {
    void this.cachePromise
      .then((cache) => cache?.put(this.key(chunk), new Response(data.slice())))
      .catch(() => {});
  }
}
