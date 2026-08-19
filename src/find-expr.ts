// High-level query compilation, mirroring Nutrimatic find-expr.cpp: parse the
// expression, append a required trailing space (so matches are complete
// words), and build the search filter.

import { ALPHABET, EPSILON, Nfa } from "./automata.js";
import { Conjunct, innerNfa, isNegated } from "./conjunct.js";
import { Filter, makeFilter } from "./expr-filter.js";
import { Box, parseExpr, parseExprBox } from "./expr-parse.js";
import { IndexReader } from "./index-reader.js";
import { SearchDriver, SearchDriverOptions } from "./search-driver.js";
import { SessionContext } from "./session-context.js";
import { ParseError } from "./parse-error.js";
// Re-exported: the whole codebase imported it from here before it moved.
export { ParseError } from "./parse-error.js";

export const DEFAULT_RESTART = 1e-6;

const CODE_SPACE = 0x20;


/**
 * Parse a query into its conjunct NFAs, each already carrying the required
 * trailing space, throwing ParseError on syntax errors. Both engines start
 * here: the JS filter is built from these, and the WASM kernel is seeded with
 * them directly.
 */
export function compileConjuncts(
  query: string,
  ctx: SessionContext,
): Conjunct[] {
  const box = new Box();
  const p = parseExprBox(query, 0, box, false, ctx);
  if (p === null || p !== query.length) {
    throw new ParseError(p === null ? query : query.slice(p));
  }

  // Require a space at the end, so the matches must be complete words.
  // The suffix is a fixed-length language, so appending it distributes over
  // the intersection: (∩Ai)·s = ∩(Ai·s). That keeps conjuncts unmaterialized.
  //
  // Negation does *not* distribute the same way — ¬A·s and ¬(A·s) are
  // different languages — so appending the space inside a negated conjunct
  // needs an argument. Every word the search can emit ends in the space and
  // so splits as w·" " in exactly one way, and for those words
  //
  //     w·" " ∈ ¬(A·" ")   ⟺   w ∉ A   ⟺   w·" " ∈ ¬A·" "
  //
  // — the two agree. They part company only on words *not* ending in a space,
  // which ¬(A·" ") admits and ¬A·" " does not, so restricting to words that do
  // is what makes appending inside the negation sound. Any positive conjunct
  // already imposes that restriction, having just had the space appended to
  // it; when every conjunct is negated there is none, and the restriction is
  // added below as its own conjunct.
  for (const conjunct of box.and) {
    const nfa = innerNfa(conjunct);
    if (!isNegated(conjunct) && nfa.finalWeight !== undefined) {
      // A weighted conjunct's finals carry per-match weights, and a plain
      // concat would merge them all into the one new final. Append the space
      // per weight class instead: finals of equal weight share a fresh
      // space-then-final pair carrying that weight. Exact, and the class
      // count is small (edit levels, soft ranks).
      appendSpaceWeighted(nfa);
      continue;
    }
    const space = new Nfa();
    parseExpr(" ", 0, space, true, ctx);
    nfa.concat(space);
  }
  const conjuncts: Conjunct[] = box.and;
  if (conjuncts.length > 0 && !conjuncts.some((c) => !isNegated(c))) {
    conjuncts.push(endsInSpace());
  }
  return conjuncts;
}

/**
 * The trailing-space append for a weighted conjunct: one fresh
 * space-then-final chain per distinct weight, so every weight survives the
 * concat that would otherwise merge the finals.
 */
function appendSpaceWeighted(nfa: Nfa): void {
  const weightOf = (s: number): number => nfa.finalWeight?.get(s) ?? 1;
  const oldFinals = [...nfa.finals];
  nfa.finals = new Set();
  const chains = new Map<number, { mid: number; final: number }>();
  const weights = new Map<number, number>();
  for (const f of oldFinals) {
    const w = weightOf(f);
    let chain = chains.get(w);
    if (chain === undefined) {
      const mid = nfa.addState();
      const final = nfa.addState();
      nfa.addArc(mid, CODE_SPACE, final);
      nfa.setFinal(final);
      chain = { mid, final };
      chains.set(w, chain);
      if (w !== 1) weights.set(final, w);
    }
    nfa.addArc(f, EPSILON, chain.mid);
  }
  nfa.finalWeight = weights.size > 0 ? weights : undefined;
}

/** Any string over the alphabet, then one space: `.*" "` without the parser. */
function endsInSpace(): Nfa {
  const nfa = new Nfa();
  const loop = nfa.addState();
  const end = nfa.addState();
  nfa.setStart(loop);
  nfa.setFinal(end);
  for (const ch of ALPHABET) nfa.addArc(loop, ch, loop);
  nfa.addArc(loop, CODE_SPACE, end);
  return nfa;
}

/** Compile a query into a filter, throwing ParseError on syntax errors. */
export function compileQuery(query: string, ctx: SessionContext): Filter {
  return makeFilter(compileConjuncts(query, ctx));
}

export function makeDriver(
  reader: IndexReader,
  filter: Filter,
  restart = DEFAULT_RESTART,
  opts: SearchDriverOptions = {},
): SearchDriver {
  return new SearchDriver(reader, filter, filter.startState, restart, opts);
}

/** Format like C's %.8g (Nutrimatic's score output format). */
export function formatScore(x: number): string {
  if (x === 0) return "0";
  let s = x.toPrecision(8);
  if (s.includes("e")) {
    let [mant, exp] = s.split("e");
    if (mant.includes(".")) mant = mant.replace(/\.?0+$/, "");
    const sign = exp[0] === "-" ? "-" : "+";
    const digits = exp.replace(/^[+-]/, "").padStart(2, "0");
    return `${mant}e${sign}${digits}`;
  }
  if (s.includes(".")) s = s.replace(/\.?0+$/, "");
  return s;
}
