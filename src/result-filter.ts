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

export type FilterSpec =
  | { kind: "compound"; pieces: number }
  | { kind: "palindrome" }
  | { kind: "reversible" };

export class FilterError extends Error {}

const NAMES = ["compound", "palindrome", "reversible"];

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
  const m = /^\{\s*([a-z]+)\s*([^:}]*):/i.exec(q);
  if (!m) return null;
  const name = m[1].toLowerCase();
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
  if (arg !== "") throw new FilterError(`{${name}:…} takes no argument`);
  return { spec: { kind: name as "palindrome" | "reversible" }, inner };
}
