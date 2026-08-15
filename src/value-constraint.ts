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

const SPACE = " ".charCodeAt(0);

/** A table scoring 1 for each character in `set`, 0 elsewhere. */
function markTable(set: Iterable<number>): number[] {
  const t = new Array(128).fill(0);
  for (const c of set) t[c] = 1;
  return t;
}

const LETTERS = Array.from({ length: 26 }, (_, i) => A + i);
const NAMED_SETS: Record<string, number[]> = {
  vowel: [..."aeiou"].map((c) => c.charCodeAt(0)),
  consonant: LETTERS.filter((c) => !"aeiou".includes(String.fromCharCode(c))),
  letter: LETTERS,
  digit: Array.from({ length: 10 }, (_, i) => "0".charCodeAt(0) + i),
};

/** `(aeiou)` or `(vowel)` → the characters it names. */
function parseSet(spec: string): { set: number[]; rest: string } | null {
  const m = /^\s*\(([a-z0-9]+)\)\s*/i.exec(spec);
  if (!m) return null;
  const body = m[1].toLowerCase();
  const set = NAMED_SETS[body] ?? [...body].map((c) => c.charCodeAt(0));
  return set.length === 0 ? null : { set, rest: spec.slice(m[0].length) };
}

/**
 * Build the conjunct automata for a named constraint, or null if the name is
 * unknown or the spec malformed.
 *
 * Multiset constraints decompose into one small automaton per letter rather
 * than one automaton over sets of letters: "no letter repeated" is 26
 * independent two-state counters, not a 2^26-state subset machine. The engine
 * intersects conjuncts lazily, so this is the cheap way to say it.
 */
export function namedConstraint(name: string, spec: string): Nfa[] | null {
  const table = VALUE_TABLES[name];
  if (table) {
    const range = parseValueRange(spec);
    return range ? [valueNfa(table, range)] : null;
  }

  switch (name) {
    case "letters": {
      const range = parseValueRange(spec);
      return range ? [valueNfa(markTable(LETTERS), range)] : null;
    }
    case "words": {
      // A match has no trailing space, so N words means N-1 spaces.
      const range = parseValueRange(spec);
      if (!range) return null;
      const hi = range.hi === Infinity ? Infinity : range.hi - 1;
      if (hi < 0) return null; // every match has at least one word
      const lo = Math.max(0, range.lo - 1);
      return [valueNfa(markTable([SPACE]), { lo, hi })];
    }
    case "count": {
      const parsed = parseSet(spec);
      if (!parsed) return null;
      const range = parseValueRange(parsed.rest);
      return range ? [valueNfa(markTable(parsed.set), range)] : null;
    }
    case "all": {
      const parsed = parseSet(spec);
      if (!parsed || parsed.rest.trim() !== "") return null;
      return parsed.set.map((c) =>
        valueNfa(markTable([c]), { lo: 1, hi: Infinity }),
      );
    }
    case "distinct": {
      if (spec.trim() !== "") return null;
      return LETTERS.map((c) => valueNfa(markTable([c]), { lo: 0, hi: 1 }));
    }
    case "maxrep": {
      const range = parseValueRange(spec);
      if (!range || range.hi === Infinity) return null;
      return LETTERS.map((c) =>
        valueNfa(markTable([c]), { lo: 0, hi: range.hi }),
      );
    }
    default:
      return null;
  }
}

/** Any string built from `allowed` (spaces always permitted). */
function alphabetNfa(allowed: Iterable<number>): Nfa {
  const nfa = new Nfa();
  const s = nfa.addState();
  nfa.setStart(s);
  nfa.setFinal(s);
  nfa.addArc(s, SPACE, s);
  for (const c of allowed) nfa.addArc(s, c, s);
  return nfa;
}

/**
 * Letter banks and sub-anagrams over a literal bag of letters.
 *
 * `sub` — any subset of the letters, respecting their multiplicities
 * ({sub:cryptography} can spell "crypt" but not "ccc").
 * `bank` — only these letters, each repeatable without limit, but every
 * distinct one must appear at least once (the puzzle convention for
 * <<washington>>).
 *
 * Both are the per-letter counters again: an upper bound per letter for a
 * sub-anagram, a lower bound of one for a bank, plus an alphabet restriction.
 * A sub-anagram is genuinely easier than the exact anagram the language
 * already has — same counting, but accepting anywhere instead of only at full
 * consumption.
 */
export function bankConstraint(letters: string, mode: "sub" | "bank"): Nfa[] | null {
  const counts = new Map<number, number>();
  for (const ch of letters.toLowerCase()) {
    if (ch === " ") continue;
    const c = ch.charCodeAt(0);
    if (c < A || c > Z) return null; // letters only
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const conjuncts = [alphabetNfa(counts.keys())];
  for (const [c, n] of counts) {
    conjuncts.push(
      mode === "sub"
        ? valueNfa(markTable([c]), { lo: 0, hi: n })
        : valueNfa(markTable([c]), { lo: 1, hi: Infinity }),
    );
  }
  return conjuncts;
}
