// Minimal automata library replacing OpenFST for Nutrimatic's needs.
//
// The expression language only ever produces unweighted acceptors over the
// alphabet {space, 0-9, a-z}, with label 0 acting as epsilon (upstream uses
// FST label 0, notably for the '-' = "optional space" syntax). So instead of
// weighted FSTs we implement: NFA build combinators (union/concat/closure),
// determinization with built-in epsilon handling, Moore minimization with
// dead-state trimming (which also drops states that can't reach acceptance,
// matching OpenFST's Connect()), DFA product intersection, and language
// equivalence via canonical minimal DFAs.

export const EPSILON = 0;

// Alphabet: space, digits, lowercase letters.
export const ALPHABET: number[] = [
  0x20,
  ...Array.from({ length: 10 }, (_, i) => 0x30 + i),
  ...Array.from({ length: 26 }, (_, i) => 0x61 + i),
];
export const NSYM = ALPHABET.length;

export const CHAR_TO_SYM = new Int8Array(128).fill(-1);
ALPHABET.forEach((ch, i) => {
  CHAR_TO_SYM[ch] = i;
});

export interface Arc {
  label: number; // character code, or EPSILON
  to: number;
}

/** Mutable NFA with the OpenFST-style combinators the parser needs. */
export class Nfa {
  arcs: Arc[][] = [];
  start = -1;
  finals = new Set<number>();

  addState(): number {
    this.arcs.push([]);
    return this.arcs.length - 1;
  }

  addArc(from: number, label: number, to: number): void {
    this.arcs[from].push({ label, to });
  }

  setStart(s: number): void {
    this.start = s;
  }

  setFinal(s: number): void {
    this.finals.add(s);
  }

  clone(): Nfa {
    const out = new Nfa();
    out.start = this.start;
    out.finals = new Set(this.finals);
    out.arcs = this.arcs.map((list) => list.map((a) => ({ ...a })));
    return out;
  }

  copyFrom(other: Nfa): void {
    const copy = other.clone();
    this.arcs = copy.arcs;
    this.start = copy.start;
    this.finals = copy.finals;
  }

  /** Import another NFA's states; returns the state-id offset. */
  private importStates(other: Nfa): number {
    const offset = this.arcs.length;
    for (const list of other.arcs) {
      this.arcs.push(list.map((a) => ({ label: a.label, to: a.to + offset })));
    }
    return offset;
  }

  /** this = this ∪ other. */
  union(other: Nfa): void {
    if (other.start === -1) return;
    if (this.start === -1) {
      this.copyFrom(other);
      return;
    }
    const offset = this.importStates(other);
    const ns = this.addState();
    this.addArc(ns, EPSILON, this.start);
    this.addArc(ns, EPSILON, other.start + offset);
    for (const f of other.finals) this.finals.add(f + offset);
    this.start = ns;
  }

  /** this = this · other. */
  concat(other: Nfa): void {
    if (this.start === -1) return; // empty · L = empty
    if (other.start === -1) {
      // L · empty = empty
      this.arcs = [];
      this.start = -1;
      this.finals.clear();
      return;
    }
    const offset = this.importStates(other);
    for (const f of this.finals) {
      this.addArc(f, EPSILON, other.start + offset);
    }
    this.finals = new Set([...other.finals].map((f) => f + offset));
  }

  /** this = this* (Kleene closure). */
  closureStar(): void {
    const ns = this.addState();
    if (this.start !== -1) {
      this.addArc(ns, EPSILON, this.start);
      for (const f of this.finals) this.addArc(f, EPSILON, ns);
    }
    this.finals.add(ns);
    this.start = ns;
  }
}

/**
 * Deterministic automaton over the fixed alphabet. `start === -1` means the
 * empty language (zero states). Transitions are dense: trans[s * NSYM + sym],
 * -1 for none.
 */
export interface Dfa {
  start: number;
  accepting: Uint8Array;
  trans: Int32Array;
}

export const EMPTY_DFA: Dfa = {
  start: -1,
  accepting: new Uint8Array(0),
  trans: new Int32Array(0),
};

const MAX_DFA_STATES = 500000;

/** Subset construction with epsilon closures folded in. */
export function determinize(nfa: Nfa): Dfa {
  if (nfa.start === -1) return EMPTY_DFA;

  const n = nfa.arcs.length;
  const closures: Array<number[] | null> = new Array(n).fill(null);
  const closureOf = (s: number): number[] => {
    const cached = closures[s];
    if (cached) return cached;
    const seen = new Set<number>([s]);
    const work = [s];
    while (work.length) {
      const q = work.pop()!;
      for (const a of nfa.arcs[q]) {
        if (a.label === EPSILON && !seen.has(a.to)) {
          seen.add(a.to);
          work.push(a.to);
        }
      }
    }
    const list = [...seen].sort((x, y) => x - y);
    closures[s] = list;
    return list;
  };

  const closeSet = (states: Iterable<number>): number[] => {
    const seen = new Set<number>();
    for (const s of states) for (const c of closureOf(s)) seen.add(c);
    return [...seen].sort((x, y) => x - y);
  };

  const subsetIds = new Map<string, number>();
  const subsets: number[][] = [];
  const accepting: number[] = [];
  const trans: number[] = [];

  const internSubset = (states: number[]): number => {
    const key = states.join(",");
    let id = subsetIds.get(key);
    if (id !== undefined) return id;
    id = subsets.length;
    if (id >= MAX_DFA_STATES) throw new Error("pattern too complex");
    subsetIds.set(key, id);
    subsets.push(states);
    accepting.push(states.some((s) => nfa.finals.has(s)) ? 1 : 0);
    for (let i = 0; i < NSYM; ++i) trans.push(-1);
    return id;
  };

  const startId = internSubset(closeSet([nfa.start]));
  for (let id = 0; id < subsets.length; ++id) {
    const bySym: Array<number[] | null> = new Array(NSYM).fill(null);
    for (const s of subsets[id]) {
      for (const a of nfa.arcs[s]) {
        if (a.label === EPSILON) continue;
        const sym = CHAR_TO_SYM[a.label];
        if (sym === -1) throw new Error(`bad label ${a.label}`);
        (bySym[sym] ??= []).push(a.to);
      }
    }
    for (let sym = 0; sym < NSYM; ++sym) {
      const targets = bySym[sym];
      if (!targets) continue;
      trans[id * NSYM + sym] = internSubset(closeSet(targets));
    }
  }

  return {
    start: startId,
    accepting: Uint8Array.from(accepting),
    trans: Int32Array.from(trans),
  };
}

/**
 * Minimization via Hopcroft partition refinement, emitted with a canonical
 * BFS renumbering. States equivalent to the implicit dead state (including
 * states that cannot reach acceptance) are removed; if the language is empty,
 * returns EMPTY_DFA. Output is canonical: equal languages give byte-equal
 * structures.
 */
export function minimize(dfa: Dfa): Dfa {
  if (dfa.start === -1) return EMPTY_DFA;
  const n = dfa.accepting.length;
  const dead = n; // implicit dead state id
  const total = n + 1;

  const target = (s: number, sym: number): number =>
    s === dead ? dead : dfa.trans[s * NSYM + sym] === -1 ? dead : dfa.trans[s * NSYM + sym];

  // Inverse transition table in CSR form, symbol-major: predecessors of
  // state t under symbol c live in invData[invStart[c*total+t] ..
  // invStart[c*total+t+1]).
  const invStart = new Int32Array(NSYM * total + 1);
  for (let s = 0; s < total; ++s) {
    for (let sym = 0; sym < NSYM; ++sym) {
      invStart[sym * total + target(s, sym) + 1]++;
    }
  }
  for (let i = 1; i < invStart.length; ++i) invStart[i] += invStart[i - 1];
  const invData = new Int32Array(NSYM * total);
  const cursor = invStart.slice(0, -1);
  for (let s = 0; s < total; ++s) {
    for (let sym = 0; sym < NSYM; ++sym) {
      invData[cursor[sym * total + target(s, sym)]++] = s;
    }
  }

  // Partition refinement structure: elems holds all states grouped by block,
  // loc[s] is s's index in elems, blocks are [bStart[b], bEnd[b]) slices.
  const elems = new Int32Array(total);
  const loc = new Int32Array(total);
  const blockOf = new Int32Array(total);
  const bStart: number[] = [];
  const bEnd: number[] = [];
  {
    // Block 0: non-accepting (incl. dead). Block 1: accepting (if any).
    let lo = 0;
    let hi = total;
    const acc = (s: number) => s !== dead && dfa.accepting[s] !== 0;
    for (let s = 0; s < total; ++s) {
      const i = acc(s) ? --hi : lo++;
      elems[i] = s;
      loc[s] = i;
      blockOf[s] = acc(s) ? 1 : 0;
    }
    bStart.push(0);
    bEnd.push(lo);
    if (hi < total) {
      bStart.push(lo);
      bEnd.push(total);
    }
  }

  // Worklist of (block, symbol) splitters, encoded block*NSYM+sym. Seeding
  // with every block is at most 2x the classic "smaller half" seeding and
  // keeps the code simple; splits below do use the smaller half.
  const inW = new Uint8Array((total + 2) * NSYM);
  const work: number[] = [];
  for (let b = 0; b < bStart.length; ++b) {
    for (let sym = 0; sym < NSYM; ++sym) {
      inW[b * NSYM + sym] = 1;
      work.push(b * NSYM + sym);
    }
  }

  const markCount = new Int32Array(total + 1);
  const touched: number[] = [];
  const preimage: number[] = [];

  while (work.length > 0) {
    const pair = work.pop()!;
    inW[pair] = 0;
    const A = (pair / NSYM) | 0;
    const c = pair % NSYM;

    // Collect the preimage of A under c before any mutation.
    preimage.length = 0;
    for (let i = bStart[A]; i < bEnd[A]; ++i) {
      const q = elems[i];
      const base = c * total + q;
      for (let j = invStart[base]; j < invStart[base + 1]; ++j) {
        preimage.push(invData[j]);
      }
    }

    // Mark preimage states by moving them to the front of their blocks.
    touched.length = 0;
    for (const s of preimage) {
      const b = blockOf[s];
      if (markCount[b] === 0) touched.push(b);
      const markEnd = bStart[b] + markCount[b];
      const pos = loc[s];
      if (pos < markEnd) continue; // already marked
      const other = elems[markEnd];
      elems[markEnd] = s;
      elems[pos] = other;
      loc[s] = markEnd;
      loc[other] = pos;
      markCount[b]++;
    }

    for (const b of touched) {
      const m = markCount[b];
      markCount[b] = 0;
      if (m === bEnd[b] - bStart[b]) continue; // whole block marked: no split

      // Carve the marked front region into a new block.
      const nb = bStart.length;
      bStart.push(bStart[b]);
      bEnd.push(bStart[b] + m);
      bStart[b] += m;
      for (let i = bStart[nb]; i < bEnd[nb]; ++i) blockOf[elems[i]] = nb;

      for (let d = 0; d < NSYM; ++d) {
        const pOld = b * NSYM + d;
        const pNew = nb * NSYM + d;
        if (inW[pOld]) {
          inW[pNew] = 1;
          work.push(pNew);
        } else {
          const smaller =
            bEnd[nb] - bStart[nb] <= bEnd[b] - bStart[b] ? pNew : pOld;
          inW[smaller] = 1;
          work.push(smaller);
        }
      }
    }
  }

  const classOf = blockOf;
  const numClasses = bStart.length;
  const deadClass = classOf[dead];
  // (Accepting states can never share the dead class: the initial partition
  // separates them.)
  if (classOf[dfa.start] === deadClass) {
    return EMPTY_DFA;
  }

  // Canonical BFS renumbering over classes, skipping the dead class.
  const classRep = new Int32Array(numClasses).fill(-1);
  for (let s = 0; s < n; ++s) {
    if (classRep[classOf[s]] === -1) classRep[classOf[s]] = s;
  }
  const newId = new Int32Array(numClasses).fill(-1);
  const order: number[] = [];
  const visit = (cls: number): number => {
    if (newId[cls] !== -1) return newId[cls];
    newId[cls] = order.length;
    order.push(cls);
    return newId[cls];
  };
  visit(classOf[dfa.start]);
  for (let i = 0; i < order.length; ++i) {
    const rep = classRep[order[i]];
    for (let sym = 0; sym < NSYM; ++sym) {
      const t = target(rep, sym);
      const tCls = classOf[t];
      if (tCls !== deadClass) visit(tCls);
    }
  }

  const m = order.length;
  const accepting = new Uint8Array(m);
  const trans = new Int32Array(m * NSYM).fill(-1);
  for (let i = 0; i < m; ++i) {
    const rep = classRep[order[i]];
    accepting[i] = rep === dead ? 0 : dfa.accepting[rep];
    for (let sym = 0; sym < NSYM; ++sym) {
      const t = target(rep, sym);
      const tCls = classOf[t];
      if (tCls !== deadClass) trans[i * NSYM + sym] = newId[tCls];
    }
  }

  return { start: 0, accepting, trans };
}

/** Reachable-states-only product of two DFAs (language intersection). */
export function product(a: Dfa, b: Dfa): Dfa {
  if (a.start === -1 || b.start === -1) return EMPTY_DFA;

  const ids = new Map<number, number>();
  const pairs: number[] = [];
  const accepting: number[] = [];
  const trans: number[] = [];
  const bWidth = b.accepting.length;

  const intern = (sa: number, sb: number): number => {
    const key = sa * bWidth + sb;
    let id = ids.get(key);
    if (id !== undefined) return id;
    id = pairs.length / 2;
    if (id >= MAX_DFA_STATES) throw new Error("pattern too complex");
    ids.set(key, id);
    pairs.push(sa, sb);
    accepting.push(a.accepting[sa] && b.accepting[sb] ? 1 : 0);
    for (let i = 0; i < NSYM; ++i) trans.push(-1);
    return id;
  };

  intern(a.start, b.start);
  for (let id = 0; id * 2 < pairs.length; ++id) {
    const sa = pairs[id * 2];
    const sb = pairs[id * 2 + 1];
    for (let sym = 0; sym < NSYM; ++sym) {
      const ta = a.trans[sa * NSYM + sym];
      if (ta === -1) continue;
      const tb = b.trans[sb * NSYM + sym];
      if (tb === -1) continue;
      trans[id * NSYM + sym] = intern(ta, tb);
    }
  }

  return {
    start: 0,
    accepting: Uint8Array.from(accepting),
    trans: Int32Array.from(trans),
  };
}

/** Convert a DFA back to an NFA so the parser can keep composing it. */
/**
 * The complement of a language: everything over the alphabet that `nfa` does
 * not accept. Negation is the missing dual of the `&` intersection the
 * language already has.
 *
 * Complementing means determinizing first, so it is capped: beyond
 * `maxStates` this returns null and the caller reports a parse error rather
 * than letting a subpattern explode. Short, literal-ish subpatterns — the
 * ones people actually negate — stay far below it.
 */
export function complement(nfa: Nfa, maxStates = 5000): Nfa | null {
  const dfa = determinize(nfa);
  if (dfa.start === -1) {
    // The empty language complements to everything.
    const all = new Nfa();
    const s = all.addState();
    all.setStart(s);
    all.setFinal(s);
    for (const ch of ALPHABET) all.addArc(s, ch, s);
    return all;
  }
  const n = dfa.accepting.length;
  if (n > maxStates) return null;
  // Complete the DFA with a sink, then flip acceptance: a word the original
  // rejects by having no transition is one the complement must accept.
  const sink = n;
  const accepting = new Uint8Array(n + 1);
  const trans = new Int32Array((n + 1) * NSYM).fill(sink);
  for (let st = 0; st < n; ++st) {
    accepting[st] = dfa.accepting[st] ? 0 : 1;
    for (let sym = 0; sym < NSYM; ++sym) {
      const t = dfa.trans[st * NSYM + sym];
      trans[st * NSYM + sym] = t === -1 ? sink : t;
    }
  }
  accepting[sink] = 1;
  return dfaToNfa({ start: dfa.start, accepting, trans });
}

export function dfaToNfa(dfa: Dfa): Nfa {
  const out = new Nfa();
  if (dfa.start === -1) return out;
  const n = dfa.accepting.length;
  for (let s = 0; s < n; ++s) out.addState();
  out.setStart(dfa.start);
  for (let s = 0; s < n; ++s) {
    if (dfa.accepting[s]) out.setFinal(s);
    for (let sym = 0; sym < NSYM; ++sym) {
      const t = dfa.trans[s * NSYM + sym];
      if (t !== -1) out.addArc(s, ALPHABET[sym], t);
    }
  }
  return out;
}

/**
 * Trim an NFA to its useful states: reachable from the start AND able to
 * reach a final state (OpenFST's Connect()). Returns a new NFA; empty
 * language yields an NFA with start === -1. Linear in the NFA size.
 */
export function trim(nfa: Nfa): Nfa {
  const out = new Nfa();
  if (nfa.start === -1) return out;
  const n = nfa.arcs.length;

  const forward = new Uint8Array(n);
  const stack = [nfa.start];
  forward[nfa.start] = 1;
  while (stack.length > 0) {
    const s = stack.pop()!;
    for (const a of nfa.arcs[s]) {
      if (!forward[a.to]) {
        forward[a.to] = 1;
        stack.push(a.to);
      }
    }
  }

  const reverse: number[][] = Array.from({ length: n }, () => []);
  for (let s = 0; s < n; ++s) {
    for (const a of nfa.arcs[s]) reverse[a.to].push(s);
  }
  const backward = new Uint8Array(n);
  for (const f of nfa.finals) {
    if (forward[f] && !backward[f]) {
      backward[f] = 1;
      stack.push(f);
    }
  }
  while (stack.length > 0) {
    const s = stack.pop()!;
    for (const p of reverse[s]) {
      if (forward[p] && !backward[p]) {
        backward[p] = 1;
        stack.push(p);
      }
    }
  }

  if (!backward[nfa.start]) return out; // empty language

  const newId = new Int32Array(n).fill(-1);
  for (let s = 0; s < n; ++s) {
    if (forward[s] && backward[s]) newId[s] = out.addState();
  }
  out.setStart(newId[nfa.start]);
  for (const f of nfa.finals) {
    if (newId[f] !== -1) out.setFinal(newId[f]);
  }
  for (let s = 0; s < n; ++s) {
    if (newId[s] === -1) continue;
    for (const a of nfa.arcs[s]) {
      if (newId[a.to] !== -1) out.addArc(newId[s], a.label, newId[a.to]);
    }
  }
  return out;
}

/** Upstream OptimizeExpr: rmepsilon + determinize + minimize. */
export function optimizeToDfa(nfa: Nfa): Dfa {
  return minimize(determinize(nfa));
}

export function optimize(nfa: Nfa): Nfa {
  return dfaToNfa(optimizeToDfa(nfa));
}

/** Language equivalence via canonical minimal DFAs. */
export function equivalent(a: Nfa, b: Nfa): boolean {
  const da = optimizeToDfa(a);
  const db = optimizeToDfa(b);
  if (da.start !== db.start) return false;
  if (da.accepting.length !== db.accepting.length) return false;
  for (let i = 0; i < da.accepting.length; ++i) {
    if (da.accepting[i] !== db.accepting[i]) return false;
  }
  for (let i = 0; i < da.trans.length; ++i) {
    if (da.trans[i] !== db.trans[i]) return false;
  }
  return true;
}

/** Upstream IntersectExprs: pairwise tree of optimized products. */
export function intersectExprs(exprs: Nfa[], out: Nfa): void {
  if (exprs.length === 1) {
    out.copyFrom(exprs[0]);
    return;
  }
  let input = exprs.slice();
  while (input.length > 1) {
    const output: Nfa[] = [];
    if (input.length % 2 > 0) {
      output.push(input[input.length - 1]);
    }
    for (let i = 0; i + 1 < input.length; i += 2) {
      const a = optimizeToDfa(input[i]);
      const b = optimizeToDfa(input[i + 1]);
      output.push(dfaToNfa(product(a, b)));
    }
    input = output;
  }
  out.copyFrom(input[0]);
}
