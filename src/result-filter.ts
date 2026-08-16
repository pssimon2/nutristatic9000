// Filters applied to finished matches rather than to the automaton, for the
// questions a regular language cannot ask: does this read the same backwards,
// is its reversal also a word, does it cut into words the index knows.
//
// Each keeps the pattern in charge of shape and pruning and then asks one
// bounded question per candidate. That is what makes the expensive-sounding
// items cheap: a palindrome of length n would need 26^(n/2) states as an
// automaton, and reversal would need a whole reverse-direction index to walk
// in tandem — but checked per candidate, both are a single string operation
// and at most one index lookup.

import { namesAtLevel, resolveConstruct } from "./constructs.js";

export type FilterSpec =
  | { kind: "compound"; pieces: number }
  | { kind: "palindrome" }
  | { kind: "reversible" }
  | { kind: "syllables"; lo: number; hi: number }
  | { kind: "stress"; shape: string };

export class FilterError extends Error {}

const NAMES = namesAtLevel("predicate");

/** Letters and digits of `text`, spaces dropped. */
export function letters(text: string): string {
  return text.replace(/ /g, "");
}

/** Reads the same backwards, ignoring where the words fall. */
export function isPalindrome(text: string): boolean {
  const s = letters(text);
  if (s.length < 2) return false; // a single letter is not a puzzle answer
  for (let i = 0, j = s.length - 1; i < j; ++i, --j) {
    if (s[i] !== s[j]) return false;
  }
  return true;
}

export function reversed(text: string): string {
  return [...letters(text)].reverse().join("");
}

/**
 * Split a whole-query `{name spec:PATTERN}` result filter. Returns null when
 * the query isn't one; throws when it is one but malformed.
 */
export function parseFilterWrapper(
  query: string,
): { spec: FilterSpec; inner: string } | null {
  const q = query.trim();
  const m = /^\{\s*([a-z][a-z.]*)\s*([^:}]*):/i.exec(q);
  if (!m) return null;
  const token = m[1].toLowerCase();
  // The group prefix is optional here too: {match.palindrome:…}.
  if (token.includes(".")) {
    const resolved = resolveConstruct(token, m[2]);
    if (resolved && "error" in resolved) throw new FilterError(resolved.error);
  }
  const name = token.slice(token.lastIndexOf(".") + 1);
  if (!NAMES.includes(name)) return null;
  if (!q.endsWith("}")) {
    throw new FilterError(`{${name} …} must wrap the whole pattern`);
  }
  const inner = q.slice(m[0].length, q.length - 1).trim();
  if (inner === "") throw new FilterError(`{${name} …} needs a pattern`);
  const arg = m[2].trim();

  if (name === "compound") {
    const n = /^=?\s*(\d+)$/.exec(arg);
    const pieces = n ? parseInt(n[1], 10) : NaN;
    // One piece is just "is a word", which every match already is; beyond
    // five it is a runaway split with no puzzle behind it.
    if (!(pieces >= 2 && pieces <= 5)) {
      throw new FilterError("{compound N:…} takes 2 to 5 pieces");
    }
    return { spec: { kind: "compound", pieces }, inner };
  }
  if (name === "syllables") {
    // Same comparisons the counting constraints take.
    const m = /^(=|<=|>=|<|>)?\s*(\d+)(?:\s*\.\.\s*(\d+))?$/.exec(arg);
    if (!m) {
      throw new FilterError('{syllables …} takes a count, e.g. {syllables=3:…}');
    }
    const n = Number(m[2]);
    const upper = m[3] === undefined ? n : Number(m[3]);
    const ranges: Record<string, [number, number]> = {
      "<": [0, n - 1],
      "<=": [0, n],
      ">": [n + 1, Infinity],
      ">=": [n, Infinity],
      "=": [n, upper],
      "": [n, upper],
    };
    const [lo, hi] = ranges[m[1] ?? ""];
    if (hi < lo) throw new FilterError(`empty range (${lo}-${hi})`);
    return { spec: { kind: "syllables", lo, hi }, inner };
  }
  if (name === "stress") {
    if (!/^[012]+$/.test(arg)) {
      throw new FilterError(
        "{stress:…} takes a shape of 0, 1 and 2 — one digit per syllable, " +
          "e.g. {stress:100:…} for a dactyl",
      );
    }
    return { spec: { kind: "stress", shape: arg }, inner };
  }
  if (arg !== "") throw new FilterError(`{${name}:…} takes no argument`);
  return { spec: { kind: name as "palindrome" | "reversible" }, inner };
}
