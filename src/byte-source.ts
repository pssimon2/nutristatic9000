// Random-access byte sources backing an index file.
//
// The index trie is read with small backwards scans from node offsets, so a
// source only needs: total length, "make [start,end) available", and
// single-byte reads. ensure() may complete synchronously (memory) or return a
// promise (HTTP Range fetch); callers use maybeAsync() to stay on the fast
// path when everything is already cached.

/** Reusable holder for view(): bytes[pos - base] is the byte at file offset pos. */
export class ViewHolder {
  bytes: Uint8Array = new Uint8Array(0);
  base = 0;
}

export interface ByteSource {
  readonly length: number;
  /** Make bytes [start, end) available for byte(). May resolve synchronously. */
  ensure(start: number, end: number): void | Promise<void>;
  /** Read one byte inside a previously ensured range. */
  byte(pos: number): number;
  /**
   * Fill `out` with a contiguous view covering the previously ensured range
   * [start, end) if one is cheaply available; returns false if the range is
   * not contiguous in memory (caller falls back to byte()).
   */
  view(start: number, end: number, out: ViewHolder): boolean;
  /**
   * Optional hint that [start, end) will likely be read soon. Unlike
   * ensure(), the source may drop the hint (e.g. to protect a slow link
   * from speculative traffic).
   */
  prefetchHint?(start: number, end: number): void;
}

/**
 * Cache validator for a served file: ETag + Last-Modified combined. Null when
 * the server provides neither (validation impossible, callers fall back to
 * size-only checks). Used to catch same-size index rebuilds.
 */
export function validatorOf(headers: Headers): string | null {
  return validatorFrom(headers.get("etag"), headers.get("last-modified"));
}

/**
 * The same combination from parts, for callers who carry the two header
 * values rather than a Headers (the page's early probe). Both spellings must
 * produce byte-identical strings or a cached copy compares unequal to itself
 * and is thrown away — hence one function.
 */
export function validatorFrom(
  etag: string | null | undefined,
  modified: string | null | undefined,
): string | null {
  return etag || modified ? `${etag ?? ""}|${modified ?? ""}` : null;
}

/** Await only if needed, keeping the common cached case synchronous. */
export function maybeAsync<T>(
  prep: void | Promise<void>,
  fn: () => T,
): T | Promise<T> {
  if (prep) return prep.then(fn);
  return fn();
}

export class MemorySource implements ByteSource {
  constructor(private readonly data: Uint8Array) {}
  get length(): number {
    return this.data.length;
  }
  ensure(): void {}
  byte(pos: number): number {
    return this.data[pos];
  }
  view(_start: number, _end: number, out: ViewHolder): boolean {
    out.bytes = this.data;
    out.base = 0;
    return true;
  }
}

/** The synchronous read surface of a FileSystemSyncAccessHandle. */
export interface SyncFileReader {
  read(buffer: Uint8Array, options: { at: number }): number;
  close?(): void;
}

/**
 * Index stored in a local file with synchronous random reads (browser OPFS
 * sync access handles in a worker, or any equivalent). Chunks are read on
 * demand into a small LRU — a multi-GB downloaded index opens instantly and
 * searches at near-memory speed without ever being loaded whole into RAM.
 * All operations are synchronous, so the search loop never awaits.
 */
export class SyncFileSource implements ByteSource {
  private readonly cache = new Map<number, Uint8Array>();

  constructor(
    private readonly file: SyncFileReader,
    readonly length: number,
    private readonly chunkSize = 1 << 17,
    maxChunks?: number,
  ) {
    // Broad searches walk working sets in the hundreds of MB; a small LRU
    // thrashes into per-node file reads, which is far slower. Users on this
    // path explicitly downloaded the index, so scale the cache up to the full
    // file, capped at 512MB.
    this.maxChunks =
      maxChunks ?? Math.min(4096, Math.ceil(length / this.chunkSize));
  }

  private readonly maxChunks: number;

  private chunk(c: number): Uint8Array {
    let data = this.cache.get(c);
    if (data) {
      this.cache.delete(c);
      this.cache.set(c, data);
      return data;
    }
    const start = c * this.chunkSize;
    const size = Math.min(this.chunkSize, this.length - start);
    data = new Uint8Array(size);
    let got = 0;
    while (got < size) {
      const n = this.file.read(data.subarray(got), { at: start + got });
      if (n <= 0) throw new Error(`short read at ${start + got}`);
      got += n;
    }
    this.cache.set(c, data);
    if (this.cache.size > this.maxChunks) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return data;
  }

  ensure(start: number, end: number): void {
    const first = Math.floor(start / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    for (let c = first; c <= last; ++c) this.chunk(c);
  }

  byte(pos: number): number {
    return this.chunk(Math.floor(pos / this.chunkSize))[pos % this.chunkSize];
  }

  view(start: number, end: number, out: ViewHolder): boolean {
    const c = Math.floor(start / this.chunkSize);
    if (c !== Math.floor((end - 1) / this.chunkSize)) return false;
    out.bytes = this.chunk(c);
    out.base = c * this.chunkSize;
    return true;
  }

  /**
   * Bulk-read [at, at + target.length) directly into `target`, bypassing the
   * chunk LRU (used to copy a whole index into WASM linear memory).
   */
  readInto(target: Uint8Array, at: number): void {
    let got = 0;
    while (got < target.length) {
      const n = this.file.read(target.subarray(got), { at: at + got });
      if (n <= 0) throw new Error(`short read at ${at + got}`);
      got += n;
    }
  }

  /** Release the underlying file handle (its lock blocks other openers). */
  close(): void {
    try {
      this.file.close?.();
    } catch {
      // already closed
    }
  }
}

/** Optional persistent store for fetched chunks (e.g. browser Cache API). */
/**
 * How far a miss-fetch may reach backwards, in chunks.
 *
 * The index is written post-order, so a node's descendants lie contiguously
 * *before* it, and extending a fetch backwards preloads the subtree the walk
 * is about to enter. The size comes from the bandwidth-delay product — on a
 * slow link it is naturally tiny — and this caps it, because on a fast link
 * the product alone would fetch large fractions of the index.
 *
 * It was 32, then 8, and both were too many. The walk's locality varies
 * enormously by query and the read-ahead does not: a phrase search follows one
 * subtree and uses what it is given, while `{kind:bird}&A{7}` or
 * `{elements:A{6}}` jump about and use one block of every eight. Since a run
 * is capped on *bytes*, the unused seven come straight out of how deep the
 * search gets, and those two queries reached the 64 MB cap having found
 * nothing at all — 412 and 432 steps, where their first match sits at step
 * 1,695 and 491.
 *
 * Measured against the deployed 1.3 GB index at 8 blocks and at 2:
 *
 *   {kind:bird}&A{7}      0 results, 69.7 MB  ->  10 results, 57.1 MB
 *   {elements:A{6}}       0 results, 67.3 MB  ->  10 results, 38.7 MB
 *   {syllables=3:A{7}}    0 kept              ->  article, history, october
 *   <aaagmnr>            10 results, 21.1 MB  ->  10 results, 11.4 MB
 *   solar s_stem         10 results, 30.5 MB  ->  10 results, 15.0 MB
 *
 * So it halves the bytes on the searches that were already working and makes
 * a class of them work at all. It is not free: a search that is already
 * request-bound rather than byte-bound gets slower, `"_ ___ ___ _*burger"`
 * from 8.7 s to 13.3 s at the same 67 MB, because the same bytes now arrive in
 * 1,248 requests instead of 515.
 *
 * 3 and 4 were measured too: both leave `{kind:bird}&A{7}` returning nothing,
 * so the choice is really 2 against 8, and returning nothing is a worse
 * outcome than taking longer.
 *
 * The honest fix is to adapt — measure how much of each read-ahead is read
 * before it is evicted, and shrink when the answer is "one block" — because no
 * constant is right for both shapes: at 2 the anagram on the front page goes
 * from 1.7 s to 3.6 s in the browser while its transfer drops from 43 MB to
 * 11 MB. This is the better constant meanwhile.
 */
export const MAX_READAHEAD_BLOCKS = 2;

export interface ChunkStore {
  get(chunk: number): Promise<Uint8Array | undefined>;
  /** Fire-and-forget; failures must be swallowed by the store. */
  put(chunk: number, data: Uint8Array): void;
}

export interface HttpRangeSourceOptions {
  chunkSize?: number;
  maxChunks?: number;
  fetchFn?: typeof fetch;
  chunkStore?: ChunkStore;
  /** Probe results already known (skips the 1-byte probe request). */
  known?: { length: number; supportsRanges: boolean };
}

/**
 * Reads an index served as a plain static file, fetching fixed-size chunks
 * with HTTP Range requests and keeping an LRU cache. This is what lets a
 * multi-gigabyte index live on any static host with no server-side code.
 */
export class HttpRangeSource implements ByteSource {
  private readonly cache = new Map<number, Uint8Array>();
  // Chunks currently being loaded, so concurrent ensure()/prefetch calls for
  // the same chunk share one request instead of double-fetching.
  private readonly inflight = new Map<number, Promise<void>>();
  // The span of the most recent ensure(), held un-evictable until the next
  // one. An empty range by construction, so nothing is pinned before the
  // first call.
  private pinFirst = 0;
  private pinLast = -1;
  bytesFetched = 0;
  requests = 0;
  /** Chunk cache outcomes: the ratio is what makes range mode viable. */
  chunkHits = 0;
  chunkMisses = 0;
  // Live estimates of link bandwidth (bytes/s) and round-trip time (s),
  // driving the read-ahead size (bandwidth-delay product): the index is
  // written post-order, so a node's descendants lie contiguously BEFORE it —
  // extending a miss-fetch backwards preloads the subtree the search is
  // about to walk. On fast links that collapses serial per-level round
  // trips; on slow links the product (and the read-ahead) is naturally tiny.
  private ewmaBw = 1e6;
  private ewmaRtt = 0.08;
  /** Whether the probe confirmed the server honors Range requests. */
  supportsRanges = false;
  /** ETag/Last-Modified captured by the probe; null when unknown. */
  validator: string | null = null;

  private constructor(
    private readonly url: string,
    readonly length: number,
    private readonly chunkSize: number,
    private readonly maxChunks: number,
    private readonly fetchFn: typeof fetch,
    private readonly chunkStore?: ChunkStore,
  ) {}

  static async open(
    url: string,
    opts: HttpRangeSourceOptions = {},
  ): Promise<HttpRangeSource> {
    const fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
    if (opts.known) {
      const source = new HttpRangeSource(
        url,
        opts.known.length,
        opts.chunkSize ?? 1 << 16,
        opts.maxChunks ?? 1024,
        fetchFn,
        opts.chunkStore,
      );
      source.supportsRanges = opts.known.supportsRanges;
      return source;
    }
    // Probe with a 1-byte range GET: works on static hosts that disallow
    // HEAD, and verifies Range support in one round trip.
    const probe = await fetchFn(url, { headers: { Range: "bytes=0-0" } });
    if (!probe.ok) throw new Error(`can't fetch ${url}: HTTP ${probe.status}`);
    let length: number;
    let supportsRanges = false;
    const contentRange = probe.headers.get("content-range");
    if (probe.status === 206 && contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (!m) throw new Error(`bad Content-Range from ${url}: ${contentRange}`);
      length = parseInt(m[1], 10);
      supportsRanges = true;
    } else {
      // Server ignored the Range header; it must have sent the whole file.
      const len = probe.headers.get("content-length");
      if (!len) throw new Error(`no Content-Length from ${url}`);
      length = parseInt(len, 10);
    }
    await probe.body?.cancel();
    const validator = validatorOf(probe.headers);
    const source = new HttpRangeSource(
      url,
      length,
      opts.chunkSize ?? 1 << 16,
      opts.maxChunks ?? 1024,
      fetchFn,
      opts.chunkStore,
    );
    source.supportsRanges = supportsRanges;
    source.validator = validator;
    return source;
  }

  ensure(start: number, end: number): void | Promise<void> {
    return this.load(start, end, true);
  }

  /**
   * `pin` marks the span as one a caller is waiting to read.
   *
   * Whatever ensure() promises must survive until the caller has read it: the
   * read happens in the continuation, so a speculative prefetch completing in
   * between would otherwise be free to evict it — and the caller's next act is
   * a *synchronous* byte(), which cannot re-fetch. A prefetch passes false,
   * because it is nobody's promise and must not displace the pin protecting a
   * real read.
   */
  private load(
    start: number,
    end: number,
    pin: boolean,
  ): void | Promise<void> {
    const first = Math.floor(start / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    if (pin) {
      this.pinFirst = first;
      this.pinLast = last;
    }
    let missing: number[] | null = null;
    for (let c = first; c <= last; ++c) {
      const hit = this.cache.get(c);
      if (hit) {
        ++this.chunkHits;
        // Refresh LRU position (Map preserves insertion order).
        this.cache.delete(c);
        this.cache.set(c, hit);
      } else {
        ++this.chunkMisses;
        (missing ??= []).push(c);
      }
    }
    if (!missing) return;
    return this.loadChunks(missing);
  }

  private loadChunks(missing: number[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const mine: number[] = [];
    for (const c of missing) {
      const shared = this.inflight.get(c);
      if (shared) waits.push(shared);
      else mine.push(c);
    }
    if (mine.length > 0) {
      const p = this.loadOwnChunks(mine).finally(() => {
        for (const c of mine) this.inflight.delete(c);
      });
      for (const c of mine) this.inflight.set(c, p);
      waits.push(p);
    }
    return Promise.all(waits).then(() => {});
  }

  private async loadOwnChunks(missing: number[]): Promise<void> {
    // Consult the persistent store first; only truly-missing chunks go to the
    // network.
    let still = missing;
    if (this.chunkStore) {
      // Concurrently: see the note in compressed-source.ts. Awaiting the
      // store once per chunk serialises that many Cache round trips ahead of
      // each network request.
      const hits = await Promise.all(
        missing.map((c) => this.chunkStore!.get(c).catch(() => undefined)),
      );
      still = [];
      for (let i = 0; i < missing.length; ++i) {
        const hit = hits[i];
        if (hit && hit.length > 0) this.insertChunk(missing[i], hit, false);
        else still.push(missing[i]);
      }
    }
    if (still.length > 0) {
      // Read-ahead: extend the fetch backwards over uncached chunks, up to
      // the current bandwidth-delay product.
      const maxExtra = Math.min(
        MAX_READAHEAD_BLOCKS,
        Math.floor((this.ewmaBw * this.ewmaRtt) / this.chunkSize),
      );
      let first = still[0];
      while (
        first > 0 &&
        still[0] - first < maxExtra &&
        !this.cache.has(first - 1) &&
        !this.inflight.has(first - 1)
      ) {
        --first;
      }
      await this.fetchChunks(first, still[still.length - 1]);
    }
  }

  private async fetchChunks(firstChunk: number, lastChunk: number): Promise<void> {
    const start = firstChunk * this.chunkSize;
    const end = Math.min((lastChunk + 1) * this.chunkSize, this.length) - 1;
    const t0 = Date.now();
    const resp = await this.fetchFn(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (!resp.ok) {
      throw new Error(`range fetch failed for ${this.url}: HTTP ${resp.status}`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    // Update the link estimates (fetches overlap, so these are effective
    // per-stream values — exactly what the read-ahead sizing wants).
    const dt = Math.max(0.001, (Date.now() - t0) / 1000);
    const rttSample = Math.max(0.005, dt - buf.length / this.ewmaBw);
    this.ewmaRtt = 0.8 * this.ewmaRtt + 0.2 * rttSample;
    const bwSample = buf.length / Math.max(0.005, dt - this.ewmaRtt);
    this.ewmaBw = 0.8 * this.ewmaBw + 0.2 * Math.min(bwSample, 5e8);
    if (resp.status !== 206 && buf.length !== end - start + 1) {
      throw new Error(`server at ${this.url} does not support Range requests`);
    }
    this.requests += 1;
    this.bytesFetched += buf.length;
    for (let c = firstChunk; c <= lastChunk; ++c) {
      const off = (c - firstChunk) * this.chunkSize;
      this.insertChunk(c, buf.subarray(off, off + this.chunkSize), true);
    }
    while (this.cache.size > this.maxChunks) {
      const oldest = this.cache.keys().next().value!;
      if (oldest >= firstChunk && oldest <= lastChunk) break; // keep what we just loaded
      if (oldest >= this.pinFirst && oldest <= this.pinLast) break; // promised
      this.cache.delete(oldest);
    }
  }

  private insertChunk(c: number, data: Uint8Array, persist: boolean): void {
    // Copy: `data` is often a subarray of a large multi-chunk fetch buffer,
    // and storing the view would pin the whole buffer for the chunk's
    // lifetime in the LRU.
    this.cache.set(c, data.slice());
    if (persist) this.chunkStore?.put(c, data);
  }

  byte(pos: number): number {
    const chunk = this.cache.get(Math.floor(pos / this.chunkSize));
    if (!chunk) throw new Error(`byte ${pos} not ensured`);
    return chunk[pos % this.chunkSize];
  }

  view(start: number, end: number, out: ViewHolder): boolean {
    const c = Math.floor(start / this.chunkSize);
    if (c !== Math.floor((end - 1) / this.chunkSize)) return false;
    const chunk = this.cache.get(c);
    if (!chunk) return false;
    // Refresh LRU position, matching what byte() reads would have done.
    this.cache.delete(c);
    this.cache.set(c, chunk);
    out.bytes = chunk;
    out.base = c * this.chunkSize;
    return true;
  }

  /**
   * Speculative load, dropped when the link is already busy relative to its
   * bandwidth-delay product — speculation must never starve the critical
   * path on a slow connection.
   */
  prefetchHint(start: number, end: number): void {
    const budget = Math.max(
      1,
      Math.floor((this.ewmaBw * this.ewmaRtt) / this.chunkSize),
    );
    if (this.inflight.size >= budget) return;
    const r = this.load(start, end, false);
    if (r) r.catch(() => {});
  }
}
