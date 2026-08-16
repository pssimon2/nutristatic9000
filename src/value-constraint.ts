// Arithmetic constraints on letter values: `{sum=100:A*}` matches text whose
// A1Z26 letter values total exactly 100, `{scrabble>25:A{5}}` scores tiles.
//
// A running sum bounded by N is just a counter with N+1 states, so these stay
// finite-state and compose with everything else. They are also the rare
// feature that pays search back rather than costing it: an open-ended `A*`
// that would otherwise wander is pruned by the ceiling, because a state whose
// sum can no longer reach the target has no outgoing arc at all.

import { ALPHABET, EPSILON, Nfa } from "./automata.js";

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

/** The largest counter a constraint may build; see valueNfa. */
export const MAX_COUNTER_STATES = 5000;

/**
 * Longest literal a construct may expand into, matching the quantifier cap
 * next door. The index window is about 40 characters, so nothing longer can
 * match; the cap only stops a careless query from building a big automaton.
 */
export const MAX_PATTERN_LENGTH = 255;

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
export function valueNfa(table: number[], range: ValueRange): Nfa | null {
  const nfa = new Nfa();
  const cap = range.hi === Infinity ? range.lo : range.hi;
  // One state per reachable total, so a careless bound is a careless
  // allocation: {sum=1000000:…} would be a million states and ~1.8 GB, enough
  // to take a browser tab down. Nothing legitimate comes close — the index
  // window is ~40 characters, so the largest possible A1Z26 total is ~1040.
  if (cap + 1 > MAX_COUNTER_STATES) return null;
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
    if (!range) return null;
    const nfa = valueNfa(table, range);
    return nfa ? [nfa] : null;
  }

  switch (name) {
    case "letters": {
      const range = parseValueRange(spec);
      if (!range) return null;
      const nfa = valueNfa(markTable(LETTERS), range);
      return nfa ? [nfa] : null;
    }
    case "words": {
      // A match has no trailing space, so N words means N-1 spaces.
      const range = parseValueRange(spec);
      if (!range) return null;
      const hi = range.hi === Infinity ? Infinity : range.hi - 1;
      if (hi < 0) return null; // every match has at least one word
      const lo = Math.max(0, range.lo - 1);
      const nfa = valueNfa(markTable([SPACE]), { lo, hi });
      return nfa ? [nfa] : null;
    }
    case "count": {
      const parsed = parseSet(spec);
      if (!parsed) return null;
      const range = parseValueRange(parsed.rest);
      if (!range) return null;
      const nfa = valueNfa(markTable(parsed.set), range);
      return nfa ? [nfa] : null;
    }
    case "all": {
      const parsed = parseSet(spec);
      if (!parsed || parsed.rest.trim() !== "") return null;
      return parsed.set.map((c) => valueNfa(markTable([c]), { lo: 1, hi: Infinity })!);
    }
    case "distinct": {
      if (spec.trim() !== "") return null;
      return LETTERS.map((c) => valueNfa(markTable([c]), { lo: 0, hi: 1 })!);
    }
    case "maxrep": {
      const range = parseValueRange(spec);
      if (!range || range.hi === Infinity) return null;
      if (range.hi + 1 > MAX_COUNTER_STATES) return null;
      return LETTERS.map((c) => valueNfa(markTable([c]), { lo: 0, hi: range.hi })!);
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
    const bound =
      mode === "sub"
        ? valueNfa(markTable([c]), { lo: 0, hi: n })
        : valueNfa(markTable([c]), { lo: 1, hi: Infinity });
    if (!bound) return null;
    conjuncts.push(bound);
  }
  return conjuncts;
}

/** Characters an edit may insert or substitute in: letters and digits, not spaces. */
const EDITABLE = [...LETTERS, ...NAMED_SETS.digit];

export interface EditOps {
  del: boolean; // the match omits a letter of the word
  add: boolean; // the match has an extra letter
  subst: boolean; // the match swaps a letter for another
}

/**
 * A Levenshtein automaton over a fixed word: state (i, e) means "matched i
 * characters of the word using e edits". Small, finite, and deterministic in
 * shape, which is the one place automata theory hands puzzles exactly what
 * they want — deleted-letter and added-letter puzzles are otherwise brute
 * force or a trip outside the tool.
 *
 * `range` bounds the edits that may be spent, and which totals are accepted:
 * {del1:cargo} wants exactly one, {edit<=2:cargo} anything up to two.
 */
export function editNfa(
  word: string,
  ops: EditOps,
  range: ValueRange,
): Nfa | null {
  const w = [...word.toLowerCase()].map((c) => c.charCodeAt(0));
  if (w.length === 0 || w.length > 40) return null;
  for (const c of w) {
    if (c !== SPACE && !(c >= A && c <= Z) && !NAMED_SETS.digit.includes(c)) {
      return null;
    }
  }
  const k = range.hi;
  if (!Number.isFinite(k) || k < 1 || k > 5) return null;

  const nfa = new Nfa();
  const id: number[][] = [];
  for (let i = 0; i <= w.length; ++i) {
    id.push([]);
    for (let e = 0; e <= k; ++e) id[i].push(nfa.addState());
  }
  nfa.setStart(id[0][0]);
  for (let i = 0; i <= w.length; ++i) {
    for (let e = 0; e <= k; ++e) {
      const from = id[i][e];
      if (i === w.length && e >= range.lo && e <= range.hi) nfa.setFinal(from);
      if (i < w.length) {
        nfa.addArc(from, w[i], id[i + 1][e]); // match
        if (e < k && ops.del) nfa.addArc(from, EPSILON, id[i + 1][e + 1]);
        if (e < k && ops.subst) {
          for (const c of EDITABLE) {
            if (c !== w[i]) nfa.addArc(from, c, id[i + 1][e + 1]);
          }
        }
      }
      if (e < k && ops.add) {
        for (const c of EDITABLE) nfa.addArc(from, c, id[i][e + 1]);
      }
    }
  }
  return nfa;
}

/** `{del1:cargo}`, `{add2:…}`, `{subst1:…}`, `{edit<=2:…}` → its automaton. */
export function editConstraint(name: string, spec: string, word: string): Nfa | null {
  if (name === "edit") {
    const range = parseValueRange(spec);
    return range
      ? editNfa(word, { del: true, add: true, subst: true }, range)
      : null;
  }
  if (!/^\d+$/.test(spec.trim())) return null;
  const n = parseInt(spec, 10);
  const ops: EditOps = {
    del: name === "del",
    add: name === "add",
    subst: name === "subst",
  };
  if (!ops.del && !ops.add && !ops.subst) return null;
  return editNfa(word, ops, { lo: n, hi: n });
}

/** Shift a letter by `n` places, leaving anything else alone. */
function shiftChar(c: number, n: number): number {
  if (c < A || c > Z) return c;
  return A + ((c - A + n) % 26);
}

/** Atbash: a<->z, b<->y, … */
function atbashChar(c: number): number {
  return c >= A && c <= Z ? Z - (c - A) : c;
}

/** An automaton matching exactly the given literal string. */
function literalNfa(chars: number[]): Nfa {
  const nfa = new Nfa();
  let state = nfa.addState();
  nfa.setStart(state);
  for (const c of chars) {
    const next = nfa.addState();
    nfa.addArc(state, c, next);
    state = next;
  }
  nfa.setFinal(state);
  return nfa;
}

/**
 * Cipher transforms over a literal: `{caesar:kdhv}` evaluates all 25 shifts at
 * once and lets the corpus say which one is a phrase, `{rot13:cvmmn}` and
 * `{caesar+5:…}` apply a known shift, `{atbash:gsv}` reflects the alphabet.
 *
 * Only the unknown-shift case really earns its keep — a known shift is
 * something you could have typed yourself — but the whole family desugars to
 * an alternation of literals before the automaton is built, so it costs
 * essentially nothing.
 *
 * Transforms operate on literals only: shifting a character class would mean
 * "the 21-letter class you get by shifting the consonants", which nobody wants.
 */
export function cipherNfa(name: string, spec: string, text: string): Nfa | null {
  const chars = [...text.toLowerCase()].map((c) => c.charCodeAt(0));
  if (chars.length === 0) return null;
  for (const c of chars) {
    if (c !== SPACE && !(c >= A && c <= Z)) return null;
  }
  const shifts: number[] = [];
  if (name === "atbash") {
    if (spec.trim() !== "") return null;
    return literalNfa(chars.map(atbashChar));
  }
  if (name === "rot") {
    if (!/^\d+$/.test(spec.trim())) return null;
    shifts.push(parseInt(spec, 10) % 26);
  } else if (name === "caesar") {
    const s = spec.trim();
    if (s === "") {
      for (let n = 1; n < 26; ++n) shifts.push(n); // every shift but identity
    } else if (/^\+?\d+$/.test(s)) {
      shifts.push(parseInt(s.replace("+", ""), 10) % 26);
    } else {
      return null;
    }
  } else {
    return null;
  }
  const nfa = literalNfa(chars.map((c) => shiftChar(c, shifts[0])));
  for (const n of shifts.slice(1)) {
    nfa.union(literalNfa(chars.map((c) => shiftChar(c, n))));
  }
  return nfa;
}

const letterSet = (s: string) => [...s].map((c) => c.charCodeAt(0));

/**
 * Letter sets that recur constantly in hunts. Each is just an alphabet
 * restriction — the cheapest kind of constraint there is.
 */
const CLASS_SETS: Record<string, number[]> = {
  // Spelled only in Roman numerals: CIVIC, MIMIC.
  roman: letterSet("ivxlcdm"),
  // Unchanged by a 180° turn: SWIMS, NOON.
  rot180: letterSet("hinosxz"),
  // Mirror-symmetric about a vertical axis (as capitals).
  mirror: letterSet("ahimotuvwxy"),
  // Renderable on a seven-segment display.
  sevenseg: letterSet("abcdefghijlnopqrstuy"),
  // QWERTY rows, as capitals: TYPEWRITER is one row.
  row1: letterSet("qwertyuiop"),
  row2: letterSet("asdfghjkl"),
  row3: letterSet("zxcvbnm"),
};

/** Enclosed counters per capital letter, the usual puzzle convention. */
const HOLES: Record<number, string> = {
  0: "cefghijklmnstuvwxyz1234567",
  1: "adopqr0469",
  2: "b8",
};

const T9: Record<string, string> = {
  "2": "abc",
  "3": "def",
  "4": "ghi",
  "5": "jkl",
  "6": "mno",
  "7": "pqrs",
  "8": "tuv",
  "9": "wxyz",
};

/** One state per last-letter, so each letter must not go backwards (or forwards). */
function monotoneNfa(descending: boolean): Nfa {
  const nfa = new Nfa();
  const start = nfa.addState();
  nfa.setStart(start);
  nfa.setFinal(start);
  const at = LETTERS.map(() => nfa.addState());
  for (let i = 0; i < 26; ++i) {
    nfa.setFinal(at[i]);
    nfa.addArc(start, LETTERS[i], at[i]);
    nfa.addArc(at[i], SPACE, at[i]); // spaces don't break the ordering
    for (let j = 0; j < 26; ++j) {
      if (descending ? j <= i : j >= i) nfa.addArc(at[i], LETTERS[j], at[j]);
    }
  }
  nfa.addArc(start, SPACE, start);
  return nfa;
}

/** A chain of character classes: `{t9:2665}` → [abc][mno][mno][jkl]. */
function classChainNfa(classes: number[][]): Nfa {
  const nfa = new Nfa();
  let state = nfa.addState();
  nfa.setStart(state);
  for (const set of classes) {
    const next = nfa.addState();
    for (const c of set) nfa.addArc(state, c, next);
    state = next;
  }
  nfa.setFinal(state);
  return nfa;
}

/** `{enum:4,3,5}` — the crossword enumeration, as words of those lengths. */
function enumNfa(lengths: number[]): Nfa | null {
  if (lengths.length === 0 || lengths.some((n) => n < 1 || n > 40)) return null;
  // One state per letter, and the quantifier cap next door is 255. Nothing
  // longer can match anyway: the index window is about 40 characters.
  if (lengths.reduce((a, b) => a + b, 0) > MAX_PATTERN_LENGTH) return null;
  const nfa = new Nfa();
  let state = nfa.addState();
  nfa.setStart(state);
  for (let w = 0; w < lengths.length; ++w) {
    if (w > 0) {
      const gap = nfa.addState();
      nfa.addArc(state, SPACE, gap);
      state = gap;
    }
    for (let i = 0; i < lengths[w]; ++i) {
      const next = nfa.addState();
      for (const c of LETTERS) nfa.addArc(state, c, next);
      state = next;
    }
  }
  nfa.setFinal(state);
  return nfa;
}

/** Structural and encoding classes; null if the name isn't one. */
export function classConstraint(name: string, spec: string): Nfa[] | null {
  if (name === "row") {
    const set = CLASS_SETS[`row${spec.trim().replace(/^=/, "")}`];
    return set ? [alphabetNfa(set)] : null;
  }
  if (name === "holes") {
    const n = /^=?\s*(\d+)$/.exec(spec.trim());
    const set = n ? HOLES[+n[1]] : undefined;
    return set ? [alphabetNfa(letterSet(set))] : null;
  }
  if (name === "ascending" || name === "descending") {
    return spec.trim() === "" ? [monotoneNfa(name === "descending")] : null;
  }
  const set = CLASS_SETS[name];
  return set && spec.trim() === "" ? [alphabetNfa(set)] : null;
}

/** Atom-style encodings that take a literal argument: t9 digits, enumerations. */
export function encodingNfa(name: string, spec: string, arg: string): Nfa | null {
  if (name === "t9") {
    if (spec.trim() !== "") return null;
    const digits = [...arg.trim()];
    if (digits.length === 0 || digits.some((d) => !T9[d])) return null;
    return classChainNfa(digits.map((d) => letterSet(T9[d])));
  }
  if (name === "enum") {
    if (spec.trim() !== "") return null;
    const parts = arg.split(",").map((p) => p.trim());
    if (parts.some((p) => !/^\d+$/.test(p))) return null;
    return enumNfa(parts.map(Number));
  }
  return null;
}

// Unspaced Morse is ambiguous, which is exactly what the corpus is for: the
// same dots and dashes resolve into every letter-splitting, and the index
// says which ones are words.
const MORSE: Record<string, string> = {
  a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.",
  h: "....", i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.",
  o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-", u: "..-",
  v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
  "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
};

/** Every letter-splitting of an unspaced Morse string, as one automaton. */
export function morseNfa(code: string): Nfa | null {
  const c = code.replace(/\s+/g, "");
  if (c.length === 0 || c.length > MAX_PATTERN_LENGTH) return null;
  if (!/^[.\-]+$/.test(c)) return null;
  const nfa = new Nfa();
  const at = Array.from({ length: c.length + 1 }, () => nfa.addState());
  nfa.setStart(at[0]);
  nfa.setFinal(at[c.length]);
  for (let i = 0; i < c.length; ++i) {
    for (const [ch, pattern] of Object.entries(MORSE)) {
      if (c.startsWith(pattern, i)) {
        nfa.addArc(at[i], ch.charCodeAt(0), at[i + pattern.length]);
      }
    }
  }
  return nfa;
}

// Chemical symbols, lowercased. Spelling a word in them (BACON = Ba+C+O+N) is
// a segmentation, which is regular: return to a boundary state after each.
const ELEMENT_SYMBOLS = (
  "h he li be b c n o f ne na mg al si p s cl ar k ca sc ti v cr mn fe co ni " +
  "cu zn ga ge as se br kr rb sr y zr nb mo tc ru rh pd ag cd in sn sb te i " +
  "xe cs ba la ce pr nd pm sm eu gd tb dy ho er tm yb lu hf ta w re os ir pt " +
  "au hg tl pb bi po at rn fr ra ac th pa u np pu am cm bk cf es fm md no lr " +
  "rf db sg bh hs mt ds rg cn nh fl mc lv ts og"
).split(" ");

export function elementSymbolCount(): number {
  return ELEMENT_SYMBOLS.length;
}

/** Text that can be spelled entirely in chemical symbols. */
export function elementsNfa(): Nfa {
  const nfa = new Nfa();
  const boundary = nfa.addState();
  nfa.setStart(boundary);
  nfa.setFinal(boundary);
  nfa.addArc(boundary, SPACE, boundary); // word breaks don't interrupt spelling
  for (const symbol of ELEMENT_SYMBOLS) {
    let state = boundary;
    for (let i = 0; i < symbol.length; ++i) {
      const next = i === symbol.length - 1 ? boundary : nfa.addState();
      nfa.addArc(state, symbol.charCodeAt(i), next);
      state = next;
    }
  }
  return nfa;
}

/** Every `{name…}` construct, for error messages and suggestions. */
export const CONSTRUCT_NAMES = [
  "rhyme", "homo", "like", "near", "kind",
  "sum", "scrabble", "count", "letters", "words", "all", "distinct", "maxrep",
  "sub", "bank", "del", "add", "subst", "edit", "caesar", "rot", "rot13",
  "rot180", "atbash", "t9", "enum", "morse", "elements", "roman", "mirror",
  "sevenseg", "holes", "row1", "row2", "row3", "ascending", "descending",
  "list", "compound", "palindrome", "reversible", "at", "rank",
];

/** Closest known construct name, when it's close enough to be a typo. */
export function suggestConstruct(name: string): string | null {
  const distance = (a: string, b: string): number => {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; ++i) {
      const row = [i];
      for (let j = 1; j <= b.length; ++j) {
        row[j] = Math.min(
          prev[j] + 1,
          row[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = row;
    }
    return prev[b.length];
  };
  let best: string | null = null;
  let bestD = Infinity;
  for (const known of CONSTRUCT_NAMES) {
    const d = distance(name, known);
    if (d < bestD) {
      bestD = d;
      best = known;
    }
  }
  return bestD <= 2 ? best : null;
}
