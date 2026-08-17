// The search filter: a DFA over the parsed expression NFA, built lazily.
//
// Upstream compiles the full DFA upfront (OpenFST determinize + minimize),
// which explodes on big anagram/intersection patterns — mostly into states
// no real search ever visits. Here subset construction runs on demand: a
// (state, symbol) transition is computed the first time the index walk asks
// for it, then memoized in a dense table. The index prunes hard, so only a
// tiny reachable fraction of the automaton ever materializes, and patterns
// that would blow up eagerly become pay-as-you-go.

import { ALPHABET, CHAR_TO_SYM, EPSILON, NSYM, Nfa, trim } from "./automata.js";
import { Conjunct, isNegated } from "./conjunct.js";

const UNCOMPUTED = -2;
const DEAD = -1;
export const MAX_STATES = 500000;

/**
 * The lazy DFA reached the most states it is allowed to build.
 *
 * This is a budget, not a mistake in the query. `{distinct:A{6}}` — a
 * documented example — really does have on the order of 300,000 reachable
 * states, one per set-of-letters-used-so-far, and a long enough search visits
 * enough of them to run out. Searching further is impossible, but everything
 * found up to that point is correct, so this is thrown as its own type: the
 * session ends the run cleanly on it and keeps the results, rather than
 * reporting a failed search and discarding them.
 */
export class FilterCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`pattern too complex (over ${limit} lazy DFA states)`);
  }
}

/** What the search driver needs from a compiled expression. */
export interface Filter {
  readonly startState: number;
  isAccepting(state: number): boolean;
  /** Next state on `ch` (a character code), or -1 if no transition. */
  transition(state: number, ch: number): number;
  /** Lazy DFA states built so far, for Stats. Free to read. */
  readonly stateCount: number;
  /**
   * Acceptance weight (W1): ≤ 1, multiplied into an accepted match's score.
   * Absent on unweighted filters, which is the zero-overhead path — the
   * driver checks once, not per step. Only meaningful on accepting states.
   */
  acceptWeight?(state: number): number;
}

export class ExprFilter implements Filter {
  readonly startState: number;

  private readonly nfa: Nfa | null; // null = empty language
  private trans: Int32Array; // [state*NSYM+sym]: target, DEAD, or UNCOMPUTED
  private accepting: number[] = [];
  private members: number[][] = []; // NFA state set per DFA state
  /** Memoised acceptance weights, when the NFA carries them. */
  private weights: number[] = [];
  /**
   * Present only when the NFA carries weights, so an unweighted filter has
   * no `acceptWeight` at all and the driver's fast path stays fast.
   */
  acceptWeight?: (state: number) => number;

  /** Lazy DFA states interned so far. */
  get stateCount(): number {
    return this.members.length;
  }
  private readonly setIds = new Map<string, number>();
  private readonly closures: Array<number[] | null>;

  constructor(parsedExpr: Nfa) {
    // Trim to useful states first (linear): eager minimization would drop
    // states that can never reach acceptance, but this lazy engine does not,
    // so without the trim the search wanders them — including via endless
    // restarts.
    parsedExpr = trim(parsedExpr);
    if (parsedExpr.start === -1) {
      // Empty language: one non-accepting state with no transitions.
      this.nfa = null;
      this.closures = [];
      this.trans = new Int32Array(NSYM).fill(DEAD);
      this.accepting = [0];
      this.members = [[]];
      this.startState = 0;
      return;
    }
    // The NFA is captured by reference and must not be mutated afterwards.
    this.nfa = parsedExpr;
    this.closures = new Array(parsedExpr.arcs.length).fill(null);
    this.trans = new Int32Array(0);
    if (parsedExpr.finalWeight !== undefined && parsedExpr.finalWeight.size > 0) {
      // The best (largest) weight among the accepting members: the match
      // could have arrived via any of them, and priority must stay an upper
      // bound. Where members separate the weights — the edit automaton keeps
      // its levels apart — this is simply the least-damaged reading.
      this.acceptWeight = (state) => this.weights[state];
    }
    this.startState = this.intern(this.closeSet([parsedExpr.start]));
  }

  get numStates(): number {
    return this.accepting.length;
  }

  isAccepting(state: number): boolean {
    return this.accepting[state] !== 0;
  }

  /** Next state on `ch` (a character code), or -1 if no transition. */
  transition(state: number, ch: number): number {
    const sym = ch < 128 ? CHAR_TO_SYM[ch] : -1;
    if (sym === -1) return DEAD;
    const t = this.trans[state * NSYM + sym];
    return t === UNCOMPUTED ? this.compute(state, sym) : t;
  }

  private compute(state: number, sym: number): number {
    const label = ALPHABET[sym];
    const targets: number[] = [];
    for (const s of this.members[state]) {
      for (const a of this.nfa!.arcs[s]) {
        if (a.label === label) targets.push(a.to);
      }
    }
    const t = targets.length === 0 ? DEAD : this.intern(this.closeSet(targets));
    this.trans[state * NSYM + sym] = t;
    return t;
  }

  private closureOf(s: number): number[] {
    const cached = this.closures[s];
    if (cached) return cached;
    const seen = new Set<number>([s]);
    const work = [s];
    while (work.length > 0) {
      const q = work.pop()!;
      for (const a of this.nfa!.arcs[q]) {
        if (a.label === EPSILON && !seen.has(a.to)) {
          seen.add(a.to);
          work.push(a.to);
        }
      }
    }
    const list = [...seen].sort((x, y) => x - y);
    this.closures[s] = list;
    return list;
  }

  private closeSet(states: number[]): number[] {
    const seen = new Set<number>();
    for (const s of states) for (const c of this.closureOf(s)) seen.add(c);
    return [...seen].sort((x, y) => x - y);
  }

  private intern(sorted: number[]): number {
    const key = sorted.join(",");
    const existing = this.setIds.get(key);
    if (existing !== undefined) return existing;

    const id = this.members.length;
    if (id >= MAX_STATES) throw new FilterCapacityError(MAX_STATES);
    this.setIds.set(key, id);
    this.members.push(sorted);
    let acc = 0;
    for (const s of sorted) {
      if (this.nfa!.finals.has(s)) {
        acc = 1;
        break;
      }
    }
    this.accepting.push(acc);
    if (this.acceptWeight !== undefined) {
      let w = 0;
      for (const s of sorted) {
        if (!this.nfa!.finals.has(s)) continue;
        const fw = this.nfa!.finalWeight!.get(s) ?? 1;
        if (fw > w) w = fw;
      }
      this.weights.push(acc === 0 ? 1 : w);
    }

    if ((id + 1) * NSYM > this.trans.length) {
      const grown = new Int32Array(Math.max(64 * NSYM, this.trans.length * 2));
      grown.fill(UNCOMPUTED);
      grown.set(this.trans);
      this.trans = grown;
    } else {
      this.trans.fill(UNCOMPUTED, id * NSYM, (id + 1) * NSYM);
    }
    return id;
  }
}

/**
 * Everything the inner filter rejects, and nothing it accepts.
 *
 * Complementing needs a *deterministic* automaton — you cannot flip acceptance
 * on an NFA, since one word can have both an accepting and a non-accepting run
 * — and it needs a *complete* one, since a word the inner automaton rejects by
 * running out of transitions is one the complement must accept. `ExprFilter`
 * supplies the first for free: its lazy subset construction is a DFA, just one
 * whose states appear as the search asks for them. This wrapper supplies the
 * second, without building the completed transition table that made the eager
 * path expensive: the missing transitions all lead to a single sink, so the
 * sink is a constant rather than a state.
 *
 * The sink accepts and never leaves itself: once a word has left the inner
 * language it cannot re-enter, and every extension of it is also outside.
 *
 * State ids are the inner filter's, shifted by one so that id 0 can be the
 * sink. The shift is why this cannot simply delegate.
 */
export class ComplementFilter implements Filter {
  readonly startState: number;

  /** The accepting, absorbing state standing in for the inner DEAD. */
  private static readonly SINK = 0;

  constructor(private readonly inner: Filter) {
    this.startState = inner.startState + 1;
  }

  /** The inner filter's states, plus the sink. */
  get stateCount(): number {
    return this.inner.stateCount + 1;
  }

  isAccepting(state: number): boolean {
    if (state === ComplementFilter.SINK) return true;
    return !this.inner.isAccepting(state - 1);
  }

  transition(state: number, ch: number): number {
    // The language is over ALPHABET, so a character outside it is outside the
    // complement too — not something the sink should swallow.
    if (ch >= 128 || CHAR_TO_SYM[ch] === -1) return DEAD;
    if (state === ComplementFilter.SINK) return ComplementFilter.SINK;
    const t = this.inner.transition(state - 1, ch);
    return t === DEAD ? ComplementFilter.SINK : t + 1;
  }
}

/**
 * Lazy product of per-conjunct lazy filters: the intersection semantics of
 * `a&b` (and of an anagram's constraint set) without ever materializing the
 * product automaton. States are interned tuples of component states; a
 * transition exists iff every component has one.
 *
 * The components are `Filter`s rather than `ExprFilter`s so that a complement
 * can be one of them: `A{6}&!{distinct:A{6}}` is a product containing a
 * complement, and materializing either side to build it would give back the
 * cost both lazy forms exist to avoid.
 */
export class ProductFilter implements Filter {
  readonly startState: number;

  private readonly subs: Filter[];
  private readonly width: number; // ints per tuple
  private trans = new Int32Array(0);
  private accepting: number[] = [];
  // Tuples in a flat pool (entry i at [i*width, (i+1)*width)); the hash
  // table stores entry+1 in open-addressed slots. A flat pool avoids the
  // string-key building and boxed hashing that dominate anagram search time
  // with a Map keyed by tuple.
  private pool = new Int32Array(0);
  private count = 0;

  /**
   * Product states interned, plus every sub-filter's own — the sub-DFAs are
   * where the states actually accumulate on an anagram.
   */
  get stateCount(): number {
    let n = this.count;
    for (const sub of this.subs) n += sub.stateCount;
    return n;
  }
  private slots = new Int32Array(1 << 12); // power of two, 0 = empty
  private slotMask = (1 << 12) - 1;

  /** Present only when some component is weighted. */
  acceptWeight?: (state: number) => number;

  constructor(subs: Filter[]) {
    this.subs = subs;
    this.width = this.subs.length;
    if (subs.some((f) => f.acceptWeight !== undefined)) {
      this.acceptWeight = (state) => {
        let w = 1;
        const base = state * this.width;
        for (let i = 0; i < this.width; ++i) {
          const sub = this.subs[i];
          if (sub.acceptWeight !== undefined) {
            w *= sub.acceptWeight(this.pool[base + i]);
          }
        }
        return w;
      };
    }
    this.startState = this.intern(this.subs.map((f) => f.startState));
  }

  private hashTuple(tuple: ArrayLike<number>, base: number): number {
    let h = 0x9e3779b9;
    for (let i = 0; i < this.width; ++i) {
      h = Math.imul(h ^ (tuple[base + i] as number), 0x85ebca6b);
      h ^= h >>> 13;
    }
    return h >>> 0;
  }

  get numStates(): number {
    return this.accepting.length;
  }

  isAccepting(state: number): boolean {
    return this.accepting[state] !== 0;
  }

  transition(state: number, ch: number): number {
    const sym = ch < 128 ? CHAR_TO_SYM[ch] : -1;
    if (sym === -1) return DEAD;
    const t = this.trans[state * NSYM + sym];
    return t === UNCOMPUTED ? this.compute(state, sym, ch) : t;
  }

  private readonly scratch: number[] = [];

  private compute(state: number, sym: number, ch: number): number {
    const base = state * this.width;
    const next = this.scratch;
    for (let i = 0; i < this.width; ++i) {
      const t = this.subs[i].transition(this.pool[base + i], ch);
      if (t === DEAD) {
        this.trans[state * NSYM + sym] = DEAD;
        return DEAD;
      }
      next[i] = t;
    }
    const id = this.intern(next);
    this.trans[state * NSYM + sym] = id;
    return id;
  }

  private intern(tuple: ArrayLike<number>): number {
    const mask = this.slotMask;
    let i = this.hashTuple(tuple, 0) & mask;
    for (;;) {
      const slot = this.slots[i];
      if (slot === 0) break;
      const base = (slot - 1) * this.width;
      let same = true;
      for (let j = 0; j < this.width; ++j) {
        if (this.pool[base + j] !== (tuple[j] as number)) {
          same = false;
          break;
        }
      }
      if (same) return slot - 1;
      i = (i + 1) & mask;
    }

    const id = this.count;
    if (id >= MAX_STATES) throw new FilterCapacityError(MAX_STATES);
    if ((id + 1) * this.width > this.pool.length) {
      const grown = new Int32Array(
        Math.max(256 * this.width, this.pool.length * 2),
      );
      grown.set(this.pool);
      this.pool = grown;
    }
    for (let j = 0; j < this.width; ++j) {
      this.pool[id * this.width + j] = tuple[j] as number;
    }
    ++this.count;
    this.slots[i] = id + 1;
    // Grow the table at ~70% load, rehashing from the pool.
    if (this.count * 10 > (this.slotMask + 1) * 7) this.rehash();

    let acc = 1;
    for (let k = 0; k < this.width; ++k) {
      if (!this.subs[k].isAccepting(tuple[k] as number)) {
        acc = 0;
        break;
      }
    }
    this.accepting.push(acc);

    if ((id + 1) * NSYM > this.trans.length) {
      const grown = new Int32Array(Math.max(64 * NSYM, this.trans.length * 2));
      grown.fill(UNCOMPUTED);
      grown.set(this.trans);
      this.trans = grown;
    } else {
      this.trans.fill(UNCOMPUTED, id * NSYM, (id + 1) * NSYM);
    }
    return id;
  }

  private rehash(): void {
    const newSize = (this.slotMask + 1) * 2;
    this.slots = new Int32Array(newSize);
    this.slotMask = newSize - 1;
    for (let e = 0; e < this.count; ++e) {
      let i = this.hashTuple(this.pool, e * this.width) & this.slotMask;
      while (this.slots[i] !== 0) i = (i + 1) & this.slotMask;
      this.slots[i] = e + 1;
    }
  }
}

/**
 * A structural fingerprint of a conjunct's NFA (A4's "conjunct identity").
 *
 * Two parses of the same query fragment build byte-identical NFAs — same
 * construction sequence, same arc order, same finals insertion order — so
 * hashing the structure gives a stable key without holding the structure.
 * Two independent 32-bit hashes plus the state and arc counts make an
 * accidental collision (which would silently reuse the wrong filter)
 * astronomically unlikely; a *miss* on structurally equal but
 * differently-built NFAs merely skips the cache.
 */
export function fingerprintConjunct(c: Conjunct): string {
  const negated = isNegated(c);
  const nfa = negated ? c.not : c;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const mix = (v: number): void => {
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h2 = Math.imul(h2 ^ v, 0x85ebca6b);
    h2 ^= h2 >>> 13;
  };
  mix(nfa.start);
  for (const f of nfa.finals) mix(f);
  let arcs = 0;
  for (let s = 0; s < nfa.arcs.length; ++s) {
    mix(~s);
    for (const a of nfa.arcs[s]) {
      mix(a.label);
      mix(a.to);
      ++arcs;
    }
  }
  return `${negated ? "!" : ""}${nfa.arcs.length}:${arcs}:${h1 >>> 0}:${h2 >>> 0}`;
}

/**
 * A small LRU of per-conjunct filters (A4), owned by whoever lives long
 * enough to profit — the worker keeps one per session. A changed query
 * rebuilds its lazy DFAs from zero even when conjuncts are shared with the
 * previous query; with the cache, `<huge-anagram>&newthing` reuses the
 * anagram filters it built seconds ago, warm state tables and all. Safe to
 * share because a filter's only mutation is memoisation: its language never
 * changes, and the MAX_STATES budget it carries is a property of the
 * automaton either way.
 */
export class FilterCache {
  private readonly map = new Map<string, Filter>();

  constructor(private readonly limit = 24) {}

  /** The filter for this conjunct, built once per fingerprint. */
  filterFor(c: Conjunct): Filter {
    const key = fingerprintConjunct(c);
    const hit = this.map.get(key);
    if (hit !== undefined) {
      // A Map iterates in insertion order; re-inserting keeps LRU order.
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const built = conjunctFilter(c);
    this.map.set(key, built);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
    return built;
  }
}

/** The lazy filter deciding one conjunct's language. */
export function conjunctFilter(c: Conjunct): Filter {
  return isNegated(c)
    ? new ComplementFilter(new ExprFilter(c.not))
    : new ExprFilter(c);
}

/** Build the appropriate filter for a conjunct list. */
export function makeFilter(conjuncts: Conjunct[], cache?: FilterCache): Filter {
  const one = (c: Conjunct): Filter =>
    cache ? cache.filterFor(c) : conjunctFilter(c);
  if (conjuncts.length === 1) return one(conjuncts[0]);
  return new ProductFilter(conjuncts.map(one));
}
