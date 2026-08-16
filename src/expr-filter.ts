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

const UNCOMPUTED = -2;
const DEAD = -1;
const MAX_STATES = 500000;

/** What the search driver needs from a compiled expression. */
export interface Filter {
  readonly startState: number;
  isAccepting(state: number): boolean;
  /** Next state on `ch` (a character code), or -1 if no transition. */
  transition(state: number, ch: number): number;
  /** Lazy DFA states built so far, for Stats. Free to read. */
  readonly stateCount: number;
}

export class ExprFilter implements Filter {
  readonly startState: number;

  private readonly nfa: Nfa | null; // null = empty language
  private trans: Int32Array; // [state*NSYM+sym]: target, DEAD, or UNCOMPUTED
  private accepting: number[] = [];
  private members: number[][] = []; // NFA state set per DFA state

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
    if (id >= MAX_STATES) throw new Error(`pattern too complex (over ${MAX_STATES} lazy DFA states)`);
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
 * Lazy product of per-conjunct lazy filters: the intersection semantics of
 * `a&b` (and of an anagram's constraint set) without ever materializing the
 * product automaton. States are interned tuples of component states; a
 * transition exists iff every component has one.
 */
export class ProductFilter implements Filter {
  readonly startState: number;

  private readonly subs: ExprFilter[];
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

  constructor(conjuncts: Nfa[]) {
    this.subs = conjuncts.map((nfa) => new ExprFilter(nfa));
    this.width = this.subs.length;
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
    if (id >= MAX_STATES) throw new Error(`pattern too complex (over ${MAX_STATES} lazy DFA states)`);
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

/** Build the appropriate filter for a conjunct list. */
export function makeFilter(conjuncts: Nfa[]): Filter {
  if (conjuncts.length === 1) return new ExprFilter(conjuncts[0]);
  return new ProductFilter(conjuncts);
}
