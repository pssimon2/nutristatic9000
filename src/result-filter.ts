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

import {
  isRelationName,
  mentionsConstruct,
  namesAtLevel,
  resolveConstruct,
} from "./constructs.js";

export type FilterSpec =
  | { kind: "compound"; pieces: number }
  | { kind: "palindrome" }
  | { kind: "reversible" }
  | { kind: "syllables"; lo: number; hi: number }
  | { kind: "stress"; shape: string }
  | { kind: "anagram"; list: string }
  /**
   * The pattern carries predicates *inside* it — `{palindrome:A{5}} {kind:bird}`
   * — so each finished match is parsed against the pattern again, exactly, with
   * every nested predicate asked of the span its node covers. The search runs
   * on the predicates' hulls (their arguments' automata); this filter is what
   * makes the hull's over-approximation honest. See span-verify.ts.
   */
  | { kind: "where"; pattern: string };

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
/** Index of the `}` matching the `{` at `open`, or -1. */
function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; ++i) {
    if (s[i] === "{") ++depth;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Peel every result filter wrapping the query, outermost first.
 *
 * They stack and mean AND: `{palindrome:{syllables=3:A{5}}}` is "a five-letter
 * palindrome of three syllables". Before this only one could be peeled, so the
 * inner one reached the pattern parser and was reported as a constraint that
 * cannot be nested — a correct message about the wrong problem.
 */
export function parseFilterWrappers(
  query: string,
): { specs: FilterSpec[]; inner: string } {
  const specs: FilterSpec[] = [];
  let inner = query.trim();
  for (;;) {
    const peeled = parseFilterWrapper(inner);
    if (!peeled) break;
    // Two of the same filter is a contradiction or a redundancy, never a
    // question anyone means to ask.
    if (specs.some((s) => s.kind === peeled.spec.kind)) {
      throw new FilterError(`{${peeled.spec.kind} …} is applied twice`);
    }
    specs.push(peeled.spec);
    inner = peeled.inner;
  }
  // Whatever predicates remain are *inside* the pattern — beside a neighbour,
  // under a quantifier, in an anagram part. The search runs on their hulls;
  // this filter re-verifies each match exactly, spans and all.
  if (inner !== "" && mentionsConstruct(inner, NAMES)) {
    specs.push({ kind: "where", pattern: inner });
  }
  return { specs, inner };
}

export function parseFilterWrapper(
  query: string,
): { spec: FilterSpec; inner: string } | null {
  const q = query.trim();
  const head = /^\{\s*([a-z][a-z.]*)\s*/i.exec(q);
  if (head === null) return null;
  // The colon that ends the spec is the one at brace depth zero. A spec used to
  // be digits or a word, so `[^:}]*` was enough; `{anagram {kind:bird}:A{6}}`
  // has a whole pattern in there, with braces and colons of its own.
  let depth = 0;
  let colon = -1;
  for (let i = head[0].length; i < q.length; ++i) {
    const c = q[i];
    if (c === "{") ++depth;
    else if (c === "}") {
      if (depth === 0) break;
      --depth;
    } else if (c === ":" && depth === 0) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;
  const m = [q.slice(0, colon + 1), head[1], q.slice(head[0].length, colon)];
  const token = m[1].toLowerCase();
  // The group prefix is optional here too: {match.palindrome:…}.
  if (token.includes(".")) {
    const resolved = resolveConstruct(token, m[2]);
    if (resolved && "error" in resolved) throw new FilterError(resolved.error);
  }
  const name = token.slice(token.lastIndexOf(".") + 1);
  if (!NAMES.includes(name)) return null;
  // A relation constrains named spans inside the pattern it wraps, so it
  // cannot be peeled and asked of the match text alone: the pattern parser
  // reads it where it stands and the verifier evaluates it with the parse.
  if (isRelationName(name)) return null;
  // The closing brace must be *this* wrapper's. Checking only that the query
  // ends in "}" let `{palindrome:A}{bank:xyz}` through as one wrapper whose
  // inner pattern was `A}{bank:xyz`, which then failed as a pattern error
  // pointing at the wrong thing.
  //
  // A wrapper that does not cover the whole query is not an error any more:
  // it is a predicate *inside* the pattern, and the pattern parser reads it
  // where it stands. Returning null hands it over.
  const close = matchingBrace(q, 0);
  if (close !== q.length - 1) return null;
  const inner = q.slice(m[0].length, close).trim();
  if (inner === "") throw new FilterError(`{${name} …} needs a pattern`);
  return { spec: parseFilterSpec(name, m[2].trim()), inner };
}

/**
 * The spec of a predicate construct — what sits between its name and the
 * colon — as a FilterSpec, or a FilterError saying what is wrong with it.
 *
 * One function because the same construct is now written in two places: as a
 * wrapper around the whole query (peeled here) and nested inside a pattern
 * (parsed by expr-parse, verified by span-verify). Both must agree on what
 * `{compound 2}` or `{syllables>=3}` means, so both call this.
 */
export function parseFilterSpec(name: string, arg: string): FilterSpec {
  if (name === "compound") {
    const n = /^=?\s*(\d+)$/.exec(arg);
    const pieces = n ? parseInt(n[1], 10) : NaN;
    // One piece is just "is a word", which every match already is; beyond
    // five it is a runaway split with no puzzle behind it.
    if (!(pieces >= 2 && pieces <= 5)) {
      throw new FilterError("{compound N:…} takes 2 to 5 pieces");
    }
    return { kind: "compound", pieces };
  }
  if (name === "anagram") {
    // `<…>` rearranges the letters you write between the brackets, so it cannot
    // rearrange a set — there is no way to spell out "any country". Asked of a
    // finished match instead, it is one lookup: sort the letters and see
    // whether any entry of the list sorts the same.
    if (arg === "") {
      throw new FilterError(
        "{anagram …} needs a list to rearrange — e.g. {anagram countries:A{6}}",
      );
    }
    return { kind: "anagram", list: arg };
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
    return { kind: "syllables", lo, hi };
  }
  if (name === "stress") {
    if (!/^[012]+$/.test(arg)) {
      throw new FilterError(
        "{stress:…} takes a shape of 0, 1 and 2 — one digit per syllable, " +
          "e.g. {stress:100:…} for a dactyl",
      );
    }
    return { kind: "stress", shape: arg };
  }
  if (arg !== "") throw new FilterError(`{${name}:…} takes no argument`);
  return { kind: name as "palindrome" | "reversible" };
}
