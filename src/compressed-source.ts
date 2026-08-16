// ByteSource over a .idxz sidecar: fetches compressed block ranges and
// decompresses in the client, roughly halving range-mode transfer sizes.
// Mirrors HttpRangeSource's behavior: LRU of (decompressed) blocks, in-flight
// dedupe, persistent chunk store, bandwidth/RTT estimation with post-order
// backward read-ahead, and budgeted speculative prefetch.

import {
  ByteSource,
  ChunkStore,
  MAX_READAHEAD_BLOCKS,
  ViewHolder,
} from "./byte-source.js";
import {
  IDXZ_HEADER_SIZE,
  IdxzHeader,
  inflateRawBlock,
  parseIdxzHeader,
  parseIdxzTable,
} from "./idxz.js";

/** Persistence for the sidecar's header+table prefix across visits. */
export interface TableStore {
  get(): Promise<Uint8Array | undefined>;
  /** Fire-and-forget; failures must be swallowed by the store. */
  put(data: Uint8Array): void;
}

export interface CompressedRangeSourceOptions {
  maxBlocks?: number;
  fetchFn?: typeof fetch;
  /**
   * Store factory invoked with the sidecar's actual block size, which must
   * be part of the store's key namespace (block indexes are meaningless
   * across different block sizes).
   */
  makeStore?: (blockSize: number) => ChunkStore | undefined;
  /** Cache for the header+table prefix (skips its fetch on revisits). */
  tableStore?: TableStore;
  /**
   * Sidecar prefix bytes fetched ahead of time (e.g. by the page before the
   * worker booted). Validated like any other source; ignored when invalid.
   */
  prefixBytes?: Uint8Array;
}

/** A sidecar's parsed header+table plus the raw prefix bytes (cacheable). */
export interface IdxzPrefix {
  header: IdxzHeader;
  table: Float64Array;
  /** Exactly `header.dataStart` bytes: the header + compressed table. */
  bytes: Uint8Array;
}

/** Parse a header+table prefix already in memory (must cover dataStart). */
export async function parseIdxzPrefix(
  bytes: Uint8Array,
  expectedSize: number,
): Promise<IdxzPrefix | null> {
  const header = parseIdxzHeader(bytes);
  if (!header || header.uncompressedSize !== expectedSize) return null;
  if (bytes.length < header.dataStart) return null;
  const table = await parseIdxzTable(
    bytes.subarray(IDXZ_HEADER_SIZE, header.dataStart),
    header.numBlocks,
  );
  if (!table) return null;
  return { header, table, bytes: bytes.subarray(0, header.dataStart) };
}

/**
 * Fetch a sidecar's header+table over ranged GETs (one optimistic 64KB round
 * trip, completed if the table runs longer). `initial` seeds the parse with
 * bytes something else already fetched (e.g. the page's early probe); when
 * they turn out unusable the fetch restarts from the network. Null means "no
 * usable sidecar" — including hosts that ignore Range (a 200 here would fail
 * every later block fetch, so it must be caught at open time).
 */
export async function fetchIdxzPrefix(
  url: string,
  expectedSize: number,
  fetchFn: typeof fetch,
  initial?: Uint8Array,
): Promise<IdxzPrefix | null> {
  try {
    let buf = initial;
    if (!buf) {
      const first = await fetchFn(url, { headers: { Range: "bytes=0-65535" } });
      if (!first.ok || first.status !== 206) return null;
      buf = new Uint8Array(await first.arrayBuffer());
    }
    const header = parseIdxzHeader(buf);
    if (!header || header.uncompressedSize !== expectedSize) {
      return initial ? fetchIdxzPrefix(url, expectedSize, fetchFn) : null;
    }
    if (buf.length < header.dataStart) {
      const rest = await fetchFn(url, {
        headers: { Range: `bytes=${buf.length}-${header.dataStart - 1}` },
      });
      if (!rest.ok || rest.status !== 206) return null;
      const more = new Uint8Array(await rest.arrayBuffer());
      const joined = new Uint8Array(header.dataStart);
      joined.set(buf);
      joined.set(more, buf.length);
      buf = joined;
    }
    return await parseIdxzPrefix(buf, expectedSize);
  } catch {
    return null;
  }
}

export class CompressedRangeSource implements ByteSource {
  private readonly cache = new Map<number, Uint8Array>();
  // Span of the most recent ensure(); empty until the first call.
  private pinFirst = 0;
  private pinLast = -1;
  private readonly inflight = new Map<number, Promise<void>>();
  bytesFetched = 0; // compressed bytes over the wire
  requests = 0;
  chunkHits = 0;
  chunkMisses = 0;
  private ewmaBw = 1e6;
  private ewmaRtt = 0.08;

  private constructor(
    private readonly sidecarUrl: string,
    private readonly header: IdxzHeader,
    private readonly table: Float64Array,
    private readonly maxBlocks: number,
    private readonly fetchFn: typeof fetch,
    private readonly chunkStore?: ChunkStore,
  ) {}

  get length(): number {
    return this.header.uncompressedSize;
  }

  /** Compression ratio (compressed/uncompressed), for diagnostics. */
  get ratio(): number {
    return this.table[this.header.numBlocks] / this.header.uncompressedSize;
  }

  /** Total sidecar bytes (header + table + blocks): the real download size. */
  get compressedSize(): number {
    return this.header.dataStart + this.table[this.header.numBlocks];
  }

  /**
   * Open `indexUrl`'s sidecar (`<indexUrl>.idxz`). Returns null if the
   * sidecar is missing, malformed, or stale (wrong uncompressed size) —
   * callers then fall back to plain ranges.
   */
  static async open(
    indexUrl: string,
    expectedSize: number,
    opts: CompressedRangeSourceOptions = {},
  ): Promise<CompressedRangeSource | null> {
    const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
    const url = indexUrl + ".idxz";
    try {
      // A cached header+table prefix skips all table traffic on revisits;
      // a corrupt or stale cache entry falls through to a fresh fetch.
      const cached = await opts.tableStore?.get().catch(() => undefined);
      let pre = cached ? await parseIdxzPrefix(cached, expectedSize) : null;
      if (!pre) {
        pre = await fetchIdxzPrefix(url, expectedSize, fetchFn, opts.prefixBytes);
        if (pre) opts.tableStore?.put(pre.bytes.slice());
      }
      if (!pre) return null;

      return new CompressedRangeSource(
        url,
        pre.header,
        pre.table,
        opts.maxBlocks ?? 4096,
        fetchFn,
        opts.makeStore?.(pre.header.blockSize),
      );
    } catch {
      return null;
    }
  }

  ensure(start: number, end: number): void | Promise<void> {
    return this.ensureInternal(start, end, true);
  }

  /** `pin`: see the note on HttpRangeSource.load — a prefetch must not pin. */
  private ensureInternal(
    start: number,
    end: number,
    pin: boolean,
  ): void | Promise<void> {
    const bs = this.header.blockSize;
    const first = Math.floor(start / bs);
    const last = Math.floor((end - 1) / bs);
    if (pin) {
      // Held un-evictable until the next ensure: the caller reads it with a
      // synchronous byte() in the continuation, and a prefetch completing in
      // between must not take it away. (Same hazard as HttpRangeSource.)
      this.pinFirst = first;
      this.pinLast = last;
    }
    let missing: number[] | null = null;
    for (let b = first; b <= last; ++b) {
      const hit = this.cache.get(b);
      if (hit) {
        ++this.chunkHits;
        this.cache.delete(b);
        this.cache.set(b, hit);
      } else {
        ++this.chunkMisses;
        (missing ??= []).push(b);
      }
    }
    if (!missing) return;
    return this.loadBlocks(missing);
  }

  private loadBlocks(missing: number[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const mine: number[] = [];
    for (const b of missing) {
      const shared = this.inflight.get(b);
      if (shared) waits.push(shared);
      else mine.push(b);
    }
    if (mine.length > 0) {
      const p = this.loadOwnBlocks(mine).finally(() => {
        for (const b of mine) this.inflight.delete(b);
      });
      for (const b of mine) this.inflight.set(b, p);
      waits.push(p);
    }
    return Promise.all(waits).then(() => {});
  }

  private async loadOwnBlocks(missing: number[]): Promise<void> {
    let still = missing;
    if (this.chunkStore) {
      // All at once, not one after another. A fetch covers several blocks
      // (read-ahead makes it up to MAX_READAHEAD_BLOCKS), and awaiting the
      // store per block put that many serial Cache round trips in front of
      // every network request — the store lookups, not the network, were
      // setting the pace: the browser issued a request every ~19 ms where the
      // same search with no store ran 2.6x faster.
      const hits = await Promise.all(
        missing.map((b) => this.chunkStore!.get(b).catch(() => undefined)),
      );
      still = [];
      for (let i = 0; i < missing.length; ++i) {
        const hit = hits[i];
        if (hit && hit.length > 0) this.insertBlock(missing[i], hit, false);
        else still.push(missing[i]);
      }
    }
    if (still.length === 0) return;

    // Backward read-ahead by bandwidth-delay product, in compressed bytes
    // (descendants precede a node in the post-order index layout), capped at
    // MAX_READAHEAD_BLOCKS — an uncapped BDP on a fast link would balloon
    // into fetching large fractions of the index.
    const budget = this.ewmaBw * this.ewmaRtt;
    let first = still[0];
    let extra = 0;
    while (
      first > 0 &&
      still[0] - first < MAX_READAHEAD_BLOCKS &&
      extra + (this.table[first] - this.table[first - 1]) <= budget &&
      !this.cache.has(first - 1) &&
      !this.inflight.has(first - 1)
    ) {
      --first;
      extra += this.table[first + 1] - this.table[first];
    }

    const lastBlock = still[still.length - 1];
    const compStart = this.header.dataStart + this.table[first];
    const compEnd = this.header.dataStart + this.table[lastBlock + 1] - 1;
    const t0 = Date.now();
    const resp = await this.fetchFn(this.sidecarUrl, {
      headers: { Range: `bytes=${compStart}-${compEnd}` },
    });
    if (!resp.ok) {
      throw new Error(`idxz fetch failed: HTTP ${resp.status}`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length !== compEnd - compStart + 1) {
      throw new Error(`idxz short response (${buf.length} bytes)`);
    }
    this.requests += 1;
    this.bytesFetched += buf.length;
    const dt = Math.max(0.001, (Date.now() - t0) / 1000);
    const rttSample = Math.max(0.005, dt - buf.length / this.ewmaBw);
    this.ewmaRtt = 0.8 * this.ewmaRtt + 0.2 * rttSample;
    const bwSample = buf.length / Math.max(0.005, dt - this.ewmaRtt);
    this.ewmaBw = 0.8 * this.ewmaBw + 0.2 * Math.min(bwSample, 5e8);

    const jobs: Promise<void>[] = [];
    for (let b = first; b <= lastBlock; ++b) {
      const off = this.table[b] - this.table[first];
      const len = this.table[b + 1] - this.table[b];
      jobs.push(
        inflateRawBlock(buf.subarray(off, off + len), this.header.blockSize).then((data) => {
          const expected = Math.min(
            this.header.blockSize,
            this.length - b * this.header.blockSize,
          );
          if (data === null || data.length !== expected) {
            throw new Error(`idxz block ${b} decompressed to ${data?.length ?? "oversize"}`);
          }
          this.insertBlock(b, data, true);
        }),
      );
    }
    await Promise.all(jobs);
    this.evict(first, lastBlock);
  }

  private insertBlock(b: number, data: Uint8Array, persist: boolean): void {
    this.cache.set(b, data);
    if (persist) this.chunkStore?.put(b, data);
  }

  private evict(keepFirst: number, keepLast: number): void {
    while (this.cache.size > this.maxBlocks) {
      const oldest = this.cache.keys().next().value!;
      if (oldest >= keepFirst && oldest <= keepLast) break;
      if (oldest >= this.pinFirst && oldest <= this.pinLast) break; // promised
      this.cache.delete(oldest);
    }
  }

  byte(pos: number): number {
    const bs = this.header.blockSize;
    const block = this.cache.get(Math.floor(pos / bs));
    if (!block) throw new Error(`byte ${pos} not ensured`);
    return block[pos % bs];
  }

  view(start: number, end: number, out: ViewHolder): boolean {
    const bs = this.header.blockSize;
    const b = Math.floor(start / bs);
    if (b !== Math.floor((end - 1) / bs)) return false;
    const block = this.cache.get(b);
    if (!block) return false;
    this.cache.delete(b);
    this.cache.set(b, block);
    out.bytes = block;
    out.base = b * bs;
    return true;
  }

  prefetchHint(start: number, end: number): void {
    const budget = Math.max(
      1,
      Math.floor((this.ewmaBw * this.ewmaRtt) / (this.header.blockSize / 2)),
    );
    if (this.inflight.size >= budget) return;
    const r = this.ensureInternal(start, end, false);
    if (r) r.catch(() => {});
  }
}
