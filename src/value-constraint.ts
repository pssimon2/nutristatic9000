// Arithmetic constraints on letter values: `{sum=100:A*}` matches text whose
// A1Z26 letter values total exactly 100, `{scrabble>25:A{5}}` scores tiles.
//
// A running sum bounded by N is just a counter with N+1 states, so these stay
// finite-state and compose with everything else. They are also the rare
// feature that pays search back rather than costing it: an open-ended `A*`
// that would otherwise wander is pruned by the ceiling, because a state whose
// sum can no longer reach the target has no outgoing arc at all.

import { ALPHABET, Nfa } from "./automata.js";

const A = "a".charCodeAt(0);
const Z = "z".charCodeAt(0);

/** a=1 … z=26; spaces and digits count 0. */
export const A1Z26: number[] = Array.from({ length: 128 }, (_, c) =>
  c >= A && c <= Z ? c - A + 1 : 0,
);

// a b c d e f g h i j k l m n o p  q r s t u v w x y z
const SCRABBLE_VALUES = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];

/** Standard English Scrabble tile values; spaces and digits count 0. */
export const SCRABBLE: number[] = Array.from({ length: 128 }, (_, c) =>
  c >= A && c <= Z ? SCRABBLE_VALUES[c - A] : 0,
);

export const VALUE_TABLES: Record<string, number[]> = {
  sum: A1Z26,
  scrabble: SCRABBLE,
};

/** Inclusive target range; `hi` may be Infinity for an open upper end. */
export interface ValueRange {
  lo: number;
  hi: number;
}

/**
 * Parse the comparison part of `{sum<op><n>:…}`: `=100`, `<30`, `<=30`, `>25`,
 * `>=25`, or `50..60`. Returns null if it isn't a valid comparison.
 */
export function parseValueRange(spec: string): ValueRange | null {
  const s = spec.trim();
  // `=50..60` and `50..60` both read as a range; the document uses the former.
  let m = /^=?\s*(\d+)\s*\.\.\s*(\d+)$/.exec(s);
  if (m) {
    const lo = +m[1];
    const hi = +m[2];
    return hi >= lo ? { lo, hi } : null;
  }
  m = /^(=|<=|>=|<|>)\s*(\d+)$/.exec(s);
  if (!m) return null;
  const n = +m[2];
  switch (m[1]) {
    case "=":
      return { lo: n, hi: n };
    case "<":
      return n === 0 ? null : { lo: 0, hi: n - 1 };
    case "<=":
      return { lo: 0, hi: n };
    case ">":
      return { lo: n + 1, hi: Infinity };
    default:
      return { lo: n, hi: Infinity };
  }
}

/**
 * An automaton accepting exactly the strings whose values under `table` sum
 * into `range`.
 *
 * Finite upper bound: one state per reachable total, and a transition is
 * simply omitted when it would overshoot — that omission is the pruning.
 * Open upper bound: totals saturate at `lo`, which is absorbing and accepting,
 * since values are non-negative and a satisfied sum can never become
 * unsatisfied.
 */
export function valueNfa(table: number[], range: ValueRange): Nfa {
  const nfa = new Nfa();
  const cap = range.hi === Infinity ? range.lo : range.hi;
  const states: number[] = [];
  for (let total = 0; total <= cap; ++total) states.push(nfa.addState());
  nfa.setStart(states[0]);
  for (let total = 0; total <= cap; ++total) {
    if (total >= range.lo && total <= range.hi) nfa.setFinal(states[total]);
    for (const ch of ALPHABET) {
      const next = total + (table[ch] ?? 0);
      if (next <= cap) nfa.addArc(states[total], ch, states[next]);
      else if (range.hi === Infinity) nfa.addArc(states[total], ch, states[cap]);
      // Otherwise the total would overshoot a finite ceiling: no arc, so the
      // search stops exploring that branch.
    }
  }
  return nfa;
}
