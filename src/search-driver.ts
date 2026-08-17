// Port of upstream search-driver.cpp: best-first search over the index trie,
// filtered by the expression DFA. Steps pop the highest count*scale frontier
// entry, expand its children, and emit each novel accepted string as it
// surfaces — so results stream out in roughly descending frequency order.
//
// The "restart" mechanism lets matches span phrases rarer than the window
// length allows: on a space, the walk may jump back to the trie root with the
// accumulated probability scaled down by `restart` (upstream uses 1e-6).
//
// The frontier and breadcrumb trail are struct-of-arrays over typed arrays:
// deep searches hold millions of entries, and one JS object per entry costs
// ~10x the memory and constant GC pressure.

import { ChoiceBuffer, IndexReader } from "./index-reader.js";
import { Filter } from "./expr-filter.js";

/**
 * 4-ary max-heap on count*scale, entries as parallel typed arrays. 4-ary
 * because each level of sift-down moves seven arrays' worth of entry data:
 * halving the depth (log4 vs log2) halves the movement, which profiling
 * showed dominating deep searches. Pop order among equal priorities differs
 * from a binary heap — both are valid; results are a priority queue either
 * way.
 */
class Frontier {
  size = 0;
  /** Largest `size` ever reached — the query's real memory cost. */
  peak = 0;
  crumb = new Int32Array(1024);
  state = new Int32Array(1024);
  /** A byte from the index, so a byte here: see the note on CrumbTrail.ch. */
  ch = new Uint8Array(1024);
  scale = new Float64Array(1024);
  count = new Float64Array(1024);
  next = new Float64Array(1024);
  private pri = new Float64Array(1024);

  // The most recently popped entry.
  topCrumb = 0;
  topState = 0;
  topCh = 0;
  topScale = 0;
  topCount = 0;
  topNext = 0;

  private grow(): void {
    const cap = this.crumb.length * 2;
    const copy = <T extends Int32Array | Uint8Array | Float64Array>(
      old: T,
      make: (n: number) => T,
    ): T => {
      const out = make(cap);
      out.set(old);
      return out;
    };
    this.crumb = copy(this.crumb, (n) => new Int32Array(n));
    this.state = copy(this.state, (n) => new Int32Array(n));
    this.ch = copy(this.ch, (n) => new Uint8Array(n));
    this.scale = copy(this.scale, (n) => new Float64Array(n));
    this.count = copy(this.count, (n) => new Float64Array(n));
    this.next = copy(this.next, (n) => new Float64Array(n));
    this.pri = copy(this.pri, (n) => new Float64Array(n));
  }

  private set(i: number, j: number): void {
    this.crumb[i] = this.crumb[j];
    this.state[i] = this.state[j];
    this.ch[i] = this.ch[j];
    this.scale[i] = this.scale[j];
    this.count[i] = this.count[j];
    this.next[i] = this.next[j];
    this.pri[i] = this.pri[j];
  }

  push(
    crumb: number,
    state: number,
    ch: number,
    scale: number,
    count: number,
    next: number,
  ): void {
    if (this.size === this.crumb.length) this.grow();
    let i = this.size++;
    if (this.size > this.peak) this.peak = this.size;
    const pri = count * scale;
    // Bubble the hole up, then write the entry once.
    while (i > 0) {
      const parent = (i - 1) >> 2;
      if (this.pri[parent] >= pri) break;
      this.set(i, parent);
      i = parent;
    }
    this.crumb[i] = crumb;
    this.state[i] = state;
    this.ch[i] = ch;
    this.scale[i] = scale;
    this.count[i] = count;
    this.next[i] = next;
    this.pri[i] = pri;
  }

  /** Pop the max entry into the top* fields. */
  pop(): void {
    this.topCrumb = this.crumb[0];
    this.topState = this.state[0];
    this.topCh = this.ch[0];
    this.topScale = this.scale[0];
    this.topCount = this.count[0];
    this.topNext = this.next[0];

    const last = --this.size;
    if (last === 0) return;
    // Sift the former last element down from the root.
    const pri = this.pri[last];
    const p = this.pri;
    let i = 0;
    for (;;) {
      const c0 = 4 * i + 1;
      if (c0 >= last) break;
      let m = c0;
      let mp = p[c0];
      const cEnd = c0 + 4 < last ? c0 + 4 : last;
      for (let c = c0 + 1; c < cEnd; ++c) {
        if (p[c] > mp) {
          m = c;
          mp = p[c];
        }
      }
      if (mp <= pri) break;
      this.set(i, m);
      i = m;
    }
    this.set(i, last);
  }
}

/** Breadcrumb trail as parallel growable typed arrays. */
class Crumbs {
  length = 0;
  parent = new Int32Array(1024);
  /**
   * The character taken at each step, which is a byte read out of the index —
   * so a byte here. The trail grows for the length of a run and is never
   * compacted, so this is 8 bytes an entry against 5.
   */
  ch = new Uint8Array(1024);

  push(parent: number, ch: number): void {
    if (this.length === this.parent.length) {
      const cap = this.parent.length * 2;
      const np = new Int32Array(cap);
      np.set(this.parent);
      this.parent = np;
      const nc = new Uint8Array(cap);
      nc.set(this.ch);
      this.ch = nc;
    }
    this.parent[this.length] = parent;
    this.ch[this.length] = ch;
    ++this.length;
  }
}

export interface SearchDriverOptions {
  /**
   * How many of the best frontier entries to prefetch from the byte source
   * on every step. Worth a few for network-backed sources (fetches overlap
   * instead of serializing); keep 0 for in-memory sources.
   */
  prefetchDepth?: number;
  /**
   * Optional frontier budget: once a result has been emitted, frontier
   * entries whose priority falls below `scoreFloor × best-emitted-score` are
   * not pushed, and are skipped if popped. Priority is an upper bound on any
   * score the entry can still reach, so nothing scoring above the floor is
   * lost — but the deep tail below it is deliberately truncated, so this
   * trades completeness of the tail for bounded frontier growth. 0 (the
   * default) disables it.
   */
  scoreFloor?: number;
  /**
   * First-letter sharding: this driver owns only results whose *whole
   * phrase* starts with one of these character codes. Applied to the seed
   * entry's expansion ONLY — a restart re-enters the root mid-walk carrying
   * its crumb, and its result's partition is fixed by the phrase's first
   * letter, so restarts must enter every root child; filtering them would
   * silently lose every phrase needing one. Shards over a partition of the
   * root's children are disjoint and complete.
   */
  seedLetters?: ReadonlyArray<number>;
}

export class SearchDriver {
  text: string | null = null;
  score = 0;

  /** Largest the frontier reached; see Stats. */
  get frontierPeak(): number {
    return this.frontier.peak;
  }

  private readonly frontier = new Frontier();
  private readonly crumbs = new Crumbs();
  private readonly tmp = new ChoiceBuffer();
  private readonly seen = new Set<string>();
  private readonly prefetchDepth: number;
  private readonly scoreFloor: number;
  /** Set when the filter carries acceptance weights. */
  private readonly weighted: boolean;
  /** Sharding: allowed first letters for the seed expansion; null = all. */
  private readonly seedMask: Uint8Array | null;
  /** Best score emitted so far, for the score-floor cutoff. */
  private best = 0;

  constructor(
    private readonly reader: IndexReader,
    private readonly filter: Filter,
    startState: number,
    private readonly restart: number,
    opts: SearchDriverOptions = {},
  ) {
    this.prefetchDepth = opts.prefetchDepth ?? 0;
    this.scoreFloor = opts.scoreFloor ?? 0;
    this.weighted = filter.acceptWeight !== undefined;
    if (opts.seedLetters !== undefined) {
      this.seedMask = new Uint8Array(256);
      for (const c of opts.seedLetters) this.seedMask[c & 0xff] = 1;
    } else {
      this.seedMask = null;
    }
    this.frontier.push(-1, startState, 0, 1.0, reader.count(), reader.root());
  }

  /** The score-floor cutoff: 0 until a result exists or the knob is off. */
  private cutoff(): number {
    return this.scoreFloor > 0 ? this.scoreFloor * this.best : 0;
  }

  /**
   * Advance one step. Returns true when there is news: either a new result
   * (`text`/`score` set) or exhaustion (`text` null). Synchronous unless the
   * byte source needs to fetch.
   */
  step(): boolean | Promise<boolean> {
    const f = this.frontier;
    if (f.size === 0) {
      this.text = null;
      this.score = 0;
      return true;
    }

    f.pop();

    // Below the floor, an entry can no longer reach a score worth keeping:
    // drop it unexpanded. (Pushes are refused too; this catches entries that
    // were above the floor when pushed and sank as `best` rose.)
    if (f.topCount * f.topScale < this.cutoff()) return false;

    // A deferred emission, marked by a bit-flipped (negative) state —
    // a leaf's `next` can legitimately be negative, so `next` cannot be the
    // marker. An accepted match whose weight pushed its score below its walk
    // priority re-entered the heap at its *exact* weighted score, so popping
    // it here is exactly its turn — weighted results stream in true
    // descending order. Its node was expanded when it was first popped; only
    // the emission is left.
    if (f.topState < 0) return this.emitTop();

    if (this.prefetchDepth > 0) {
      // The heap's first entries are the likeliest next pops; start their
      // fetches now so network round trips overlap.
      const lim = Math.min(this.prefetchDepth, f.size);
      for (let i = 0; i < lim; ++i) this.reader.prefetch(f.next[i]);
    }

    this.tmp.clear();
    const r = this.reader.childrenInto(f.topNext, f.topCount, this.tmp);
    if (r instanceof Promise) return r.then(() => this.expand());
    return this.expand();
  }

  /** Run until the next result or exhaustion. */
  async next(): Promise<void> {
    for (;;) {
      const r = this.step();
      if (r === true || (r !== false && (await r))) return;
    }
  }

  private expand(): boolean {
    const f = this.frontier;
    const tmp = this.tmp;
    const newCrumb = this.crumbs.length;

    const cut = this.cutoff();
    // The seed entry is the one with no crumb; its children are the phrase's
    // possible first letters, which is where a shard's ownership is decided.
    const seedMask = f.topCrumb === -1 ? this.seedMask : null;
    for (let i = 0; i < tmp.n; ++i) {
      if (seedMask !== null && seedMask[tmp.ch[i]] === 0) continue;
      if (tmp.count[i] * f.topScale < cut) continue;
      const state = this.filter.transition(f.topState, tmp.ch[i]);
      if (state >= 0) {
        if (this.crumbs.length === newCrumb) {
          this.crumbs.push(f.topCrumb, f.topCh);
        }
        f.push(newCrumb, state, tmp.ch[i], f.topScale, tmp.count[i], tmp.next[i]);
      }
    }

    // Scheduled BEFORE the accepting check below, which returns as soon as it
    // has a result to report. When a node was both accepting and a word
    // boundary, that return skipped this, so the phrase was never continued:
    // `e{2}a?` emitted "ee" and never looked at "ee a", while `e{2}a` — not
    // accepting at "ee ", so falling through to here — found it. The bug hid
    // behind the `seen` check, since a match reachable a second way did reach
    // this block on the duplicate visit.
    if (
      this.restart > 0.0 &&
      f.topCh === 0x20 &&
      f.topNext !== this.reader.root()
    ) {
      const scale =
        (f.topScale * f.topCount / this.reader.count()) * this.restart;
      // Once the scale underflows to zero every further result would score
      // zero anyway; dropping the restart keeps never-accepting filter states
      // (possible with lazy products) from cycling forever.
      if (scale > 0 && scale * this.reader.count() >= cut) {
        f.push(
          f.topCrumb,
          f.topState,
          0x20,
          scale,
          this.reader.count(),
          this.reader.root(),
        );
      }
    }

    if (this.filter.isAccepting(f.topState) && f.topCrumb !== -1) {
      if (this.weighted) {
        const w = this.filter.acceptWeight!(f.topState);
        if (w < 1) {
          // Not this entry's turn: re-enter the heap at the exact weighted
          // score, and emit when it surfaces. Weight 0 is a soft reject.
          if (w > 0 && f.topScale * w * f.topCount >= this.cutoff()) {
            f.push(
              f.topCrumb,
              ~f.topState,
              f.topCh,
              f.topScale * w,
              f.topCount,
              f.topNext,
            );
          }
          return false;
        }
      }
      return this.emitTop();
    }

    return false;
  }

  /** Emit the popped entry's text, if it is new. */
  private emitTop(): boolean {
    const f = this.frontier;
    let len = 0;
    for (let i = f.topCrumb; i >= 0; i = this.crumbs.parent[i]) ++len;

    const buffer = new Array<number>(len);
    buffer[--len] = f.topCh;
    for (let i = f.topCrumb; i >= 0 && len > 0; i = this.crumbs.parent[i]) {
      buffer[--len] = this.crumbs.ch[i];
    }

    const text = String.fromCharCode(...buffer);
    if (!this.seen.has(text)) {
      this.seen.add(text);
      this.text = text;
      this.score = f.topScale * f.topCount;
      if (this.score > this.best) this.best = this.score;
      return true;
    }
    return false;
  }
}
