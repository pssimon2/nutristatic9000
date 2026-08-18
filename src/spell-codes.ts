// The hunt codes: constructs that decode a typed-in encoding to letters.
//
// Each builder takes the literal text of a `{name:…}` argument and returns an
// automaton over the decoded strings — an alternation of literals, so every
// one of these works in both engines with no kernel changes. They return null
// for an argument that is not in the encoding at all; the construct row turns
// that into an error naming the expected notation.
//
// Where an encoding is ambiguous, the automaton carries *every* reading and
// the corpus decides — the same trick `{morse:…}` uses for unspaced Morse:
//
//   * a1z26 without separators: "1121215" is every way of cutting the digits
//     into numbers 1-26 — the classic pain of the most-used hunt code.
//   * Baconian: both the classic 24-letter table (I/J and U/V shared) and the
//     modern 26-letter one are decoded, unioned.
//   * Polybius: the I/J cell reads as either letter, and the C cell also
//     reads K, which covers the tap-code variant of the square.
//   * Playfair: a decoded X may be padding, so it is skippable; a decoded I
//     may have been a J before the square merged them.

import { EPSILON, Nfa } from "./automata.js";
import { MAX_PATTERN_LENGTH } from "./value-constraint.js";

const A = "a".charCodeAt(0);
const SPACE = " ".charCodeAt(0);
const code = (ch: string) => ch.charCodeAt(0);

/** A cell of a decoded chain: the letters it may read as, or a word break. */
type Cell = number[];

/** A chain of letter-set cells, with optional cells skippable. */
function chainNfa(cells: Cell[], optional?: boolean[]): Nfa | null {
  if (cells.length === 0 || cells.length > MAX_PATTERN_LENGTH) return null;
  const nfa = new Nfa();
  let state = nfa.addState();
  nfa.setStart(state);
  for (let i = 0; i < cells.length; ++i) {
    const next = nfa.addState();
    for (const c of cells[i]) nfa.addArc(state, c, next);
    if (optional?.[i]) nfa.addArc(state, EPSILON, next);
    state = next;
  }
  nfa.setFinal(state);
  return nfa;
}

/** Split an argument into tokens; "/" is a word break, commas are spaces. */
function tokens(arg: string): string[] {
  return arg
    .toLowerCase()
    .replace(/\//g, " / ")
    .split(/[\s,]+/)
    .filter((t) => t !== "");
}

// ---- A=1, B=2, … ----

/**
 * Every reading of a digit string as numbers 1-26, one letter each.
 *
 * Positions in the digit string are states; a single digit 1-9 steps one
 * place, a valid pair 10-26 steps two. Tokens separated by spaces or commas
 * are decoded independently — "20 85" is T then the readings of "85" — so a
 * fully separated argument is simply the case where every token has one
 * reading.
 */
export function a1z26Nfa(arg: string): Nfa | null {
  const parts = tokens(arg);
  if (parts.length === 0) return null;
  const nfa = new Nfa();
  let state = nfa.addState();
  nfa.setStart(state);
  let total = 0;
  for (const t of parts) {
    if (t === "/") {
      const next = nfa.addState();
      nfa.addArc(state, SPACE, next);
      state = next;
      continue;
    }
    if (!/^\d+$/.test(t)) return null;
    if ((total += t.length) > MAX_PATTERN_LENGTH) return null;
    // One state per digit boundary within the token.
    const at = [state];
    for (let i = 1; i <= t.length; ++i) at.push(nfa.addState());
    for (let i = 0; i < t.length; ++i) {
      const one = +t[i];
      if (one >= 1) nfa.addArc(at[i], A + one - 1, at[i + 1]);
      if (i + 1 < t.length) {
        const two = +t.slice(i, i + 2);
        if (two >= 10 && two <= 26) nfa.addArc(at[i], A + two - 1, at[i + 2]);
      }
    }
    // A token no reading covers ("0", "270") would leave a dead automaton;
    // saying so beats matching nothing in silence.
    const reach = new Set([0]);
    for (let i = 0; i < t.length; ++i) {
      if (!reach.has(i)) continue;
      if (+t[i] >= 1) reach.add(i + 1);
      const two = +t.slice(i, i + 2);
      if (i + 1 < t.length && two >= 10 && two <= 26) reach.add(i + 2);
    }
    if (!reach.has(t.length)) return null;
    state = at[t.length];
  }
  nfa.setFinal(state);
  return nfa;
}

// ---- Braille ----

/** Letter → its dot numbers, sorted. Exported so the explainer can undo it. */
export const BRAILLE: Record<string, string> = {
  a: "1", b: "12", c: "14", d: "145", e: "15", f: "124", g: "1245",
  h: "125", i: "24", j: "245", k: "13", l: "123", m: "134", n: "1345",
  o: "135", p: "1234", q: "12345", r: "1235", s: "234", t: "2345",
  u: "136", v: "1236", w: "2456", x: "1346", y: "13456", z: "1356",
};
const BRAILLE_CELL = new Map(
  Object.entries(BRAILLE).map(([ch, dots]) => [dots, code(ch)]),
);

/** Cells of dot numbers — `{braille:2345 125 15}` — in any dot order. */
export function brailleNfa(arg: string): Nfa | null {
  const cells: Cell[] = [];
  for (const t of tokens(arg)) {
    if (t === "/") {
      cells.push([SPACE]);
      continue;
    }
    if (!/^[1-6]+$/.test(t)) return null;
    const dots = [...new Set([...t])].sort().join("");
    const ch = BRAILLE_CELL.get(dots);
    if (ch === undefined) return null;
    cells.push([ch]);
  }
  return chainNfa(cells);
}

// ---- Baconian / 5-bit binary ----

/** One chunk of five as a letter set under a table, or null if out of range. */
function baconLetter(v: number, classic: boolean): Cell | null {
  if (!classic) return v < 26 ? [A + v] : null;
  // Classic 24-letter table: I/J share a code, as do U/V; later letters
  // shift down to fill the gaps.
  if (v >= 24) return null;
  if (v === 8) return [code("i"), code("j")];
  if (v === 19) return [code("u"), code("v")];
  const shift = v > 19 ? 2 : v > 8 ? 1 : 0;
  return [A + v + shift];
}

/**
 * Baconian A/B strings, five to a letter — `{bacon:baaba aabbb aabaa}`.
 * Both the classic 24-letter and modern 26-letter tables are read, unioned.
 */
export function baconNfa(arg: string): Nfa | null {
  const s = arg.toLowerCase().replace(/[\s,]+/g, "");
  if (!/^[ab]+$/.test(s) || s.length % 5 !== 0) return null;
  const values: number[] = [];
  for (let i = 0; i < s.length; i += 5) {
    let v = 0;
    for (let j = 0; j < 5; ++j) v = v * 2 + (s[i + j] === "b" ? 1 : 0);
    values.push(v);
  }
  let out: Nfa | null = null;
  for (const classic of [false, true]) {
    const cells = values.map((v) => baconLetter(v, classic));
    if (cells.some((c) => c === null)) continue;
    const nfa = chainNfa(cells as Cell[]);
    if (!nfa) continue;
    if (out) out.union(nfa);
    else out = nfa;
  }
  return out;
}

/** 5-bit binary, A=00001 … Z=11010 — `{bin5:10100 01000 00101}`. */
export function bin5Nfa(arg: string): Nfa | null {
  const s = arg.replace(/[\s,]+/g, "");
  if (!/^[01]+$/.test(s) || s.length % 5 !== 0) return null;
  const cells: Cell[] = [];
  for (let i = 0; i < s.length; i += 5) {
    const v = parseInt(s.slice(i, i + 5), 2);
    if (v < 1 || v > 26) return null;
    cells.push([A + v - 1]);
  }
  return chainNfa(cells);
}

// ---- Semaphore ----

/** Letter → its two flag directions, as a sorted unordered pair. */
export const SEMAPHORE: Record<string, string> = {
  a: "s sw", b: "s w", c: "nw s", d: "n s", e: "ne s", f: "e s", g: "s se",
  h: "sw w", i: "nw sw", j: "e n", k: "n sw", l: "ne sw", m: "e sw",
  n: "se sw", o: "nw w", p: "n w", q: "ne w", r: "e w", s: "se w",
  t: "n nw", u: "ne nw", v: "n se", w: "e ne", x: "ne se", y: "e nw",
  z: "e se",
};
const SEMAPHORE_PAIR = new Map(
  Object.entries(SEMAPHORE).map(([ch, pair]) => [pair, code(ch)]),
);
const DIRECTIONS = new Set(["n", "ne", "e", "se", "s", "sw", "w", "nw"]);

/** Compass pairs, one letter each — `{semaphore:n-nw 125…}`, arms in any order. */
export function semaphoreNfa(arg: string): Nfa | null {
  const cells: Cell[] = [];
  for (const t of tokens(arg)) {
    if (t === "/") {
      cells.push([SPACE]);
      continue;
    }
    const arms = t.split("-");
    if (arms.length !== 2 || arms.some((d) => !DIRECTIONS.has(d))) return null;
    const ch = SEMAPHORE_PAIR.get(arms.slice().sort().join(" "));
    if (ch === undefined) return null; // both arms in one place is no letter
    cells.push([ch]);
  }
  return chainNfa(cells);
}

// ---- ASCII ----

/** Decimal, hex (0x…) or 8-bit binary character codes — `{ascii:99 108 117 101}`. */
export function asciiNfa(arg: string): Nfa | null {
  const cells: Cell[] = [];
  for (const t of tokens(arg)) {
    let v: number;
    if (/^[01]{8}$/.test(t)) v = parseInt(t, 2);
    else if (/^0x[0-9a-f]+$/.test(t)) v = parseInt(t.slice(2), 16);
    else if (/^\d+$/.test(t)) v = parseInt(t, 10);
    else return null;
    // The corpus alphabet: letters (either case), digits, space.
    const ch = String.fromCharCode(v).toLowerCase();
    if (!/^[a-z0-9 ]$/.test(ch)) return null;
    cells.push([code(ch)]);
  }
  return chainNfa(cells);
}

// ---- Polybius square ----

// Five-by-five, I/J sharing a cell:  a b c d e / f g h i k / l m n o p /
// q r s t u / v w x y z. The C cell also reads K, which is how the tap-code
// variant of the same square merges its alphabet.
const POLYBIUS = "abcdefghiklmnopqrstuvwxyz";

/** Row-column digit pairs — `{polybius:44 23 15}`, rows and columns 1-5. */
export function polybiusNfa(arg: string): Nfa | null {
  const s = arg.replace(/[\s,]+/g, "");
  if (!/^[1-5]+$/.test(s) || s.length % 2 !== 0) return null;
  const cells: Cell[] = [];
  for (let i = 0; i < s.length; i += 2) {
    const ch = POLYBIUS[(+s[i] - 1) * 5 + (+s[i + 1] - 1)];
    if (ch === "i") cells.push([code("i"), code("j")]);
    else if (ch === "c") cells.push([code("c"), code("k")]);
    else cells.push([code(ch)]);
  }
  return chainNfa(cells);
}

// ---- Vigenère ----

/** Decode with a repeating key — `{vigenere(lemon):lxfopv ef rnhr}`. */
export function vigenereNfa(key: string, arg: string): Nfa | null {
  if (!/^[a-z]+$/.test(key)) return null;
  const cells: Cell[] = [];
  let k = 0;
  for (const ch of arg.toLowerCase()) {
    if (ch === " ") {
      cells.push([SPACE]);
      continue;
    }
    if (ch < "a" || ch > "z") return null;
    const shift = key.charCodeAt(k++ % key.length) - A;
    cells.push([A + (((code(ch) - A - shift) % 26) + 26) % 26]);
  }
  return chainNfa(cells);
}

// ---- Playfair ----

/** The 5×5 key square, J merged into I. */
function playfairSquare(key: string): string {
  let square = "";
  for (const ch of (key + "abcdefghiklmnopqrstuvwxyz").replace(/j/g, "i")) {
    if (!square.includes(ch)) square += ch;
  }
  return square;
}

/**
 * Decode Playfair digraphs — `{playfair(monarchy):gatlmzclrqcurtx}`.
 *
 * Two readings survive decoding on purpose: a decoded I may have been a J
 * before the square merged them, and a decoded X may be the padding the
 * encoder inserted between doubled letters or at the end, so X cells are
 * skippable. The corpus picks the reading that is a real word.
 */
export function playfairNfa(key: string, arg: string): Nfa | null {
  if (!/^[a-z]+$/.test(key)) return null;
  const s = arg.toLowerCase().replace(/[\s,]+/g, "").replace(/j/g, "i");
  if (!/^[a-z]*$/.test(s) || s.length === 0 || s.length % 2 !== 0) return null;
  const square = playfairSquare(key);
  const cells: Cell[] = [];
  const optional: boolean[] = [];
  const push = (ch: string) => {
    cells.push(ch === "i" ? [code("i"), code("j")] : [code(ch)]);
    optional.push(ch === "x");
  };
  for (let i = 0; i < s.length; i += 2) {
    const a = square.indexOf(s[i]);
    const b = square.indexOf(s[i + 1]);
    const [ra, ca, rb, cb] = [a / 5 | 0, a % 5, b / 5 | 0, b % 5];
    if (ra === rb && ca === cb) return null; // a doubled letter never encrypts
    if (ra === rb) {
      push(square[ra * 5 + ((ca + 4) % 5)]);
      push(square[rb * 5 + ((cb + 4) % 5)]);
    } else if (ca === cb) {
      push(square[((ra + 4) % 5) * 5 + ca]);
      push(square[((rb + 4) % 5) * 5 + cb]);
    } else {
      push(square[ra * 5 + cb]);
      push(square[rb * 5 + ca]);
    }
  }
  // All-optional would accept the empty string; a ciphertext of pure padding
  // is not a message.
  if (optional.every(Boolean)) return null;
  return chainNfa(cells, optional);
}
