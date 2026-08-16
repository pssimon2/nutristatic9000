// High-level query compilation, mirroring upstream find-expr.cpp: parse the
// expression, append a required trailing space (so matches are complete
// words), and build the search filter.

import { Nfa } from "./automata.js";
import { Filter, makeFilter } from "./expr-filter.js";
import { Box, parseExpr, parseExprBox } from "./expr-parse.js";
import { IndexReader } from "./index-reader.js";
import { SearchDriver, SearchDriverOptions } from "./search-driver.js";
import { SessionContext } from "./session-context.js";
import { ParseError } from "./parse-error.js";
// Re-exported: the whole codebase imported it from here before it moved.
export { ParseError } from "./parse-error.js";

export const DEFAULT_RESTART = 1e-6;


/**
 * Parse a query into its conjunct NFAs, each already carrying the required
 * trailing space, throwing ParseError on syntax errors. Both engines start
 * here: the JS filter is built from these, and the WASM kernel is seeded with
 * them directly.
 */
export function compileConjuncts(query: string, ctx: SessionContext): Nfa[] {
  const box = new Box();
  const p = parseExprBox(query, 0, box, false, ctx);
  if (p === null || p !== query.length) {
    throw new ParseError(p === null ? query : query.slice(p));
  }

  // Require a space at the end, so the matches must be complete words.
  // The suffix is a fixed-length language, so appending it distributes over
  // the intersection: (∩Ai)·s = ∩(Ai·s). That keeps conjuncts unmaterialized.
  for (const conjunct of box.and) {
    const space = new Nfa();
    parseExpr(" ", 0, space, true, ctx);
    conjunct.concat(space);
  }
  return box.and;
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

/** Format like C's %.8g (upstream's score output format). */
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
