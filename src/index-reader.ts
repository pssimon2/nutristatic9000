// Port of Nutrimatic index-reader.cpp.
//
// Index format (from Nutrimatic index.h): the index is a series of trie nodes,
// parents following children. Each node is a table of (letter, frequency,
// child-node-offset) entries. Node formats, selected by the last byte:
//
//   (letter freq)* (num[01..1F] | num 00)          leaf parent, byte counts
//   letter[20-7F]                                  single child, same count
//   (letter freq off)* (num+80 | num 80)           byte counts, byte offsets
//   (letter freq off:2)* (num+A0 | num A0)         byte counts, 2-byte offsets
//   (letter freq:2 off:2)* (num+C0 | num C0)       2-byte counts and offsets
//   (letter freq:8 off:8)* (num+E0 | num E0)       8-byte counts and offsets
//
// Offsets run from the end of the child node to the start of the parent node;
// all-ones means "no child". A node is addressed by the offset just past its
// end; the root is the whole file length.
//
// Counts and offsets are stored as int64 but always fit in a JS double for
// any realistic index (Wikipedia totals are ~10^10), so plain numbers are
// used throughout.

import { ByteSource, ViewHolder, maybeAsync } from "./byte-source.js";

export const NO_NODE = -1;

export interface Choice {
  ch: number; // character code
  count: number;
  next: number; // node address, or NO_NODE
}

/**
 * Reusable flat buffer for a node's children — the hot search loop reads
 * millions of nodes, so this avoids allocating a Choice object per child.
 */
export class ChoiceBuffer {
  n = 0;
  ch = new Int32Array(64);
  count = new Float64Array(64);
  next = new Float64Array(64);

  clear(): void {
    this.n = 0;
  }

  push(ch: number, count: number, next: number): void {
    if (this.n === this.ch.length) {
      const cap = this.ch.length * 2;
      const nch = new Int32Array(cap);
      nch.set(this.ch);
      this.ch = nch;
      const ncount = new Float64Array(cap);
      ncount.set(this.count);
      this.count = ncount;
      const nnext = new Float64Array(cap);
      nnext.set(this.next);
      this.next = nnext;
    }
    this.ch[this.n] = ch;
    this.count[this.n] = count;
    this.next[this.n] = next;
    ++this.n;
  }
}

// Largest possible node: count byte + mode byte + 256 entries of 17 bytes.
const MAX_NODE_SPAN = 2 + 256 * 17;

interface CachedNode {
  count: number; // caller count this was computed with (safety check)
  leftover: number;
  n: number;
  data: Float64Array; // interleaved [ch, count, next] triples
}

/**
 * Parsed-node cache. Anagram-class searches revisit the same trie nodes
 * constantly (~86% of parses observed) because restarts and many filter
 * states walk identical prefixes, and node parsing dominates search time —
 * so caching parsed child tables is a large win there. Linear scans revisit
 * ~0%, so the miss path must be almost free: this is an open-addressed hash
 * table over typed arrays (JS Map/Set keyed by Float64Array-sourced numbers
 * hash boxed doubles — ~6µs per op, 10x slower than the parse itself).
 * Nodes are admitted on their second parse; the table simply clears when
 * full instead of evicting.
 */
const CACHE_SLOTS = 1 << 17; // power of two
const CACHE_MAX_ENTRIES = 32768;
const CACHE_MAX_USED = (CACHE_SLOTS * 3) >> 2;
const SEEN = -1;
const MISS = -2;

class ParseCache {
  private keys = new Float64Array(CACHE_SLOTS); // 0 = empty (offsets are >= 1)
  private vals = new Int32Array(CACHE_SLOTS); // SEEN, or entry index
  private entries: CachedNode[] = [];
  private used = 0;

  private slot(key: number): number {
    let h = key % 0x7fffffff | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    let i = h & (CACHE_SLOTS - 1);
    const keys = this.keys;
    while (keys[i] !== 0 && keys[i] !== key) i = (i + 1) & (CACHE_SLOTS - 1);
    return i;
  }

  /** Entry index, SEEN (parsed once before), or MISS. */
  find(key: number): number {
    const i = this.slot(key);
    return this.keys[i] === 0 ? MISS : this.vals[i];
  }

  entry(idx: number): CachedNode {
    return this.entries[idx];
  }

  /** Record a first parse (MISS -> SEEN). */
  markSeen(key: number): void {
    if (this.used >= CACHE_MAX_USED) this.clear();
    const i = this.slot(key);
    if (this.keys[i] === 0) {
      this.keys[i] = key;
      this.vals[i] = SEEN;
      ++this.used;
    }
  }

  /** Promote a SEEN node to a cached entry. */
  insert(key: number, node: CachedNode): void {
    if (this.entries.length >= CACHE_MAX_ENTRIES) this.clear();
    const i = this.slot(key);
    if (this.keys[i] === 0) {
      if (this.used >= CACHE_MAX_USED) return; // full and freshly cleared race
      this.keys[i] = key;
      ++this.used;
    }
    this.vals[i] = this.entries.length;
    this.entries.push(node);
  }

  private clear(): void {
    this.keys.fill(0);
    this.entries.length = 0;
    this.used = 0;
  }
}

export class IndexReader {
  private constructor(
    readonly source: ByteSource,
    private readonly total: number,
  ) {}

  static async open(source: ByteSource): Promise<IndexReader> {
    const reader = new IndexReader(source, 0);
    // Scan the top-level nodes to compute the total count, descending through
    // single-child chain nodes that carry no count of their own. A parse
    // failure here means the bytes aren't an index at all (e.g. an HTML 404
    // page served with status 200) — say so instead of "bad size at pos N".
    let top: Choice[] = [];
    try {
      await reader.children(reader.root(), 0, top);
      while (top.length === 1 && top[0].count === 0) {
        const node = top[0].next;
        top = [];
        await reader.children(node, 0, top);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("index error:")) {
        throw new Error(
          "this doesn't look like a Nutrimatic index (is the URL right?)",
        );
      }
      throw e;
    }
    let total = 0;
    for (const c of top) total += c.count;
    return new IndexReader(source, total);
  }

  root(): number {
    return this.source.length;
  }

  count(): number {
    return this.total;
  }

  /**
   * Append the children of `parent` to `out` (object list form; used by the
   * walker and open()). Returns `count` minus the counts of all children —
   * the number of phrases that terminate at this node.
   */
  children(
    parent: number,
    count: number,
    out: Choice[],
  ): number | Promise<number> {
    const buf = new ChoiceBuffer();
    const finish = (leftover: number): number => {
      for (let i = 0; i < buf.n; ++i) {
        out.push({ ch: buf.ch[i], count: buf.count[i], next: buf.next[i] });
      }
      return leftover;
    };
    const r = this.childrenInto(parent, count, buf);
    if (r instanceof Promise) return r.then(finish);
    return finish(r);
  }

  private readonly parseCache = new ParseCache();

  /**
   * Flat-buffer version of children() for the search hot loop. Returns
   * `count` minus the counts of all children. Synchronous when the backing
   * bytes are already available.
   */
  childrenInto(
    parent: number,
    count: number,
    out: ChoiceBuffer,
  ): number | Promise<number> {
    if (parent === NO_NODE) return count;

    const found = this.parseCache.find(parent);
    if (found >= 0) {
      const hit = this.parseCache.entry(found);
      if (hit.count === count) {
        const d = hit.data;
        for (let i = 0, j = 0; i < hit.n; ++i, j += 3) {
          out.push(d[j], d[j + 1], d[j + 2]);
        }
        return hit.leftover;
      }
    }

    // Pinned before the fetch and released after the synchronous read:
    // the read cannot re-fetch, and between ensure() resolving and the read
    // running, an unrelated ensure or prefetch completing is otherwise free
    // to evict exactly these blocks. The legacy last-ensure pin protects only
    // one pending read; this protects each of them.
    const spanStart = Math.max(0, parent - MAX_NODE_SPAN);
    const token = this.source.pin?.(spanStart, parent);
    const read = (): number | Promise<number> => {
      try {
        const base = out.n;
        const leftover = this.childrenSync(parent, count, out);
        if (found === SEEN) {
          // Second parse: worth caching now.
          const n = out.n - base;
          const data = new Float64Array(n * 3);
          for (let i = 0, j = 0; i < n; ++i, j += 3) {
            data[j] = out.ch[base + i];
            data[j + 1] = out.count[base + i];
            data[j + 2] = out.next[base + i];
          }
          this.parseCache.insert(parent, { count, leftover, n, data });
        } else if (found === MISS) {
          this.parseCache.markSeen(parent);
        }
        return leftover;
      } finally {
        if (token !== undefined) this.source.unpin!(token);
      }
    };
    let r: void | Promise<void>;
    try {
      r = this.source.ensure(spanStart, parent);
    } catch (e) {
      if (token !== undefined) this.source.unpin!(token);
      throw e;
    }
    if (r instanceof Promise) {
      return r.then(read, (e) => {
        if (token !== undefined) this.source.unpin!(token);
        throw e;
      });
    }
    return read();
  }

  /**
   * Hint that `node` will likely be read soon. The source may drop the hint
   * to protect a busy or slow link; errors surface on the real read.
   */
  prefetch(node: number): void {
    if (node === NO_NODE) return;
    const start = Math.max(0, node - MAX_NODE_SPAN);
    if (this.source.prefetchHint) {
      this.source.prefetchHint(start, node);
    } else {
      const r = this.source.ensure(start, node);
      if (r) r.catch(() => {});
    }
  }

  // Reused across calls: the view holder and the cross-boundary scratch copy.
  private readonly viewHolder = new ViewHolder();
  private readonly scratch = new Uint8Array(MAX_NODE_SPAN);

  private childrenSync(n: number, count: number, out: ChoiceBuffer): number {
    const src = this.source;
    if (!(n >= 1 && n <= src.length)) this.fail(n, "node out of range");
    // From here `n` is only a boundary; reads walk `cursor` backwards from it
    // (the index is written children-first), and `remaining` counts down what
    // the children do not account for.

    // Get direct array access to the node's byte span; parsing with plain
    // indexing instead of per-byte method calls is a large hot-loop win.
    const spanStart = Math.max(0, n - MAX_NODE_SPAN);
    let cursor = n;
    let remaining = count;
    const v = this.viewHolder;
    if (!src.view(spanStart, n, v)) {
      // Span crosses a chunk boundary (~3% of nodes on chunked sources):
      // bulk-copy the pieces via single-chunk views. A per-byte loop here
      // once cost 96% of disk-mode search time (per-byte Map + LRU work).
      let p = spanStart;
      while (p < n) {
        if (src.view(p, p + 1, v)) {
          const chunkEnd = v.base + v.bytes.length;
          const take = Math.min(n, chunkEnd) - p;
          this.scratch.set(
            v.bytes.subarray(p - v.base, p - v.base + take),
            p - spanStart,
          );
          p += take;
        } else {
          this.scratch[p - spanStart] = src.byte(p);
          ++p;
        }
      }
      v.bytes = this.scratch;
      v.base = spanStart;
    }
    const b = v.bytes;
    const base = v.base;

    let num = b[--cursor - base];

    if (num >= 0x20 && num < 0x80) {
      // Single child immediately preceding, sharing this node's count.
      if (cursor < 1) this.fail(cursor, "need immediate next");
      out.push(num, count, cursor);
      return 0;
    }

    const countSize = num < 0xc0 ? 1 : num < 0xe0 ? 2 : 8;
    const offsetSize = num < 0x20 ? 0 : num < 0xa0 ? 1 : num < 0xe0 ? 2 : 8;

    num = num & 0x1f;
    if (num === 0) {
      if (cursor < 1) this.fail(cursor, "need count");
      num = b[--cursor - base];
    }

    const size = countSize + offsetSize + 1;
    if (num === 0 || cursor < num * size) this.fail(cursor, "bad size");

    const start = cursor - num * size;
    for (let p = start - base; p < cursor - base; p += size) {
      const ch = b[p];

      let childCount: number;
      if (countSize === 1) {
        childCount = b[p + 1];
      } else if (countSize === 2) {
        childCount = b[p + 1] | (b[p + 2] << 8);
      } else {
        childCount = 0;
        for (let j = 0; j < countSize; ++j) {
          childCount += b[p + 1 + j] * 2 ** (j * 8);
        }
      }
      if (childCount <= 0) this.fail(p + base + 1, "bad count");

      let next: number;
      if (offsetSize === 0) {
        next = NO_NODE;
      } else if (offsetSize === 1) {
        const offset = b[p + 1 + countSize];
        next = offset === 0xff ? NO_NODE : start - offset;
      } else if (offsetSize === 2) {
        const offset = b[p + countSize + 1] | (b[p + countSize + 2] << 8);
        next = offset === 0xffff ? NO_NODE : start - offset;
      } else {
        let offset = 0;
        let allOnes = true;
        for (let j = 0; j < offsetSize; ++j) {
          const byte = b[p + 1 + countSize + j];
          if (byte !== 0xff) allOnes = false;
          offset += byte * 2 ** (j * 8);
        }
        next = allOnes ? NO_NODE : start - offset;
      }

      if (next !== NO_NODE && (next < 0 || next > start)) {
        this.fail(p + base + 1 + countSize, "bad offset");
      }
      out.push(ch, childCount, next);
      remaining -= childCount;
    }

    // Children accounting for more than the parent holds is a corrupt index,
    // and saying so beats handing the walk a negative leftover.
    if (count > 0 && remaining < 0) {
      this.fail(cursor, "child counts exceed parent count");
    }

    return remaining;
  }

  private fail(n: number, message: string): never {
    throw new Error(`index error: pos ${n}: ${message}`);
  }
}
