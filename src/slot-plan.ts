// A query with several slots, worked out once for whichever front end asks.
//
// A hunt is rarely one pattern. The usual shape is a dozen clues, each giving
// a word, each contributing a letter, and the letters spelling the answer —
// so the query language takes several patterns separated by `;` and the page
// shows the assembled letters above the results.
//
// The splitting and the per-slot wrapper peeling lived in `web/main.ts`, which
// meant the CLI could not run a multi-slot query at all: it took the whole
// string as one pattern and failed on the first semicolon. This is that work,
// in one place, so both front ends get the same slots from the same query.
//
// Two ways to write a wrapper over several slots, and both are supported
// because both are things people write:
//
//   {at 1:A{5}};{at 2:B{6}}   a wrapper per slot
//   {at 1:A{5};B{6}}          one wrapper over all of them
//
// The second used to be split down the middle into two unparseable halves.

import type { ExtractSpec, RankSpec } from "./extract-spec.js";
import type { FilterSpec } from "./result-filter.js";
import { parseFilterWrappers } from "./result-filter.js";
import type { QueryShape } from "./query-shape.js";
import { shapeOfQuery, splitSlots } from "./query-shape.js";

export interface SlotPlan {
  /** The slot as written, for showing back to the reader. */
  query: string;
  /**
   * What this slot is, once the output wrappers are off: the pattern with the
   * predicate wrappers still on, plus what the page reads to annotate results
   * (the single caesar, the literals worth folding repeats on).
   *
   * `shape.pattern` rather than `pattern` is what a front end passes to
   * something that peels the predicates on its own side — the worker does,
   * because it is the side that can ask the index whether a piece is a word.
   */
  shape: QueryShape;
  /** What the engine compiles: every wrapper peeled off. */
  pattern: string;
  /**
   * Which letters this slot contributes, if it says — resolved, so a wrapper
   * written around all the slots has already been applied to the ones that
   * did not say for themselves. `shape.extract` is what this slot wrote.
   */
  extract: ExtractSpec | null;
  rank: RankSpec | null;
  /** Predicates checked on this slot's finished matches. */
  filters: FilterSpec[];
}

/** One slot: peel its wrappers, and fall back to the query's own if it has none. */
interface Outer {
  extract: ExtractSpec | null;
  rank: RankSpec | null;
  filters: FilterSpec[];
}

const NOTHING_OUTSIDE: Outer = { extract: null, rank: null, filters: [] };

/** The predicate kinds a slot writes for itself, or none if it does not parse. */
function ownKinds(
  part: string,
  minLiteralChars: number,
): Array<FilterSpec["kind"]> {
  try {
    return parseFilterWrappers(shapeOfQuery(part, minLiteralChars).pattern)
      .specs.map((f) => f.kind);
  } catch {
    return [];
  }
}

function planOne(
  written: string,
  minLiteralChars: number,
  outer: Outer,
): SlotPlan {
  const shape = shapeOfQuery(written, minLiteralChars);
  const filtered = parseFilterWrappers(shape.pattern);
  // A predicate written around all the slots applies to each, the same way an
  // output wrapper does — and a slot's own wins, so a kind it already carries is
  // not added twice. (`parseFilterWrappers` refuses the same kind twice within
  // one query; merging must not smuggle a duplicate past that.)
  const own = new Set(filtered.specs.map((f) => f.kind));
  const inherited = outer.filters.filter((f) => !own.has(f.kind));
  return {
    query: written,
    shape,
    pattern: filtered.inner,
    // A slot that says where its letter comes from outranks a wrapper around
    // all of them: the outer one is the default, not an override.
    extract: shape.extract ?? outer.extract,
    rank: shape.rank ?? outer.rank,
    filters: [...filtered.specs, ...inherited],
  };
}

/**
 * The slots a query asks for: one entry for a plain query, several for one
 * written with `;`.
 *
 * Throws whatever the wrapper parsers throw — `ExtractError` for a malformed
 * `{at …}`, `FilterError` for a malformed predicate — which is the caller's
 * cue to show the message rather than search.
 */
export function planSlots(query: string, minLiteralChars: number): SlotPlan[] {
  const top = splitSlots(query);
  if (top.length > 1) {
    // A wrapper per slot: each carries its own, and there is nothing outside
    // them to inherit.
    return top.map((part) => planOne(part, minLiteralChars, NOTHING_OUTSIDE));
  }

  // One top-level piece. It may still be several slots inside a wrapper, and
  // that is the only way to find out — the wrapper parsers insist on covering
  // the whole string, so this cannot be asked before the split above.
  //
  // Both kinds of wrapper are peeled here, in the order they nest: an output
  // wrapper outside a predicate outside the pattern. Only the output wrappers
  // used to be, so `{at 1:A{5};A{6}}` was two slots and
  // `{palindrome:A{5};A{6}}` was a parse error — the same shape, one of them
  // working, for no reason a reader could see.
  const shape = shapeOfQuery(top[0] ?? query, minLiteralChars);
  const filtered = parseFilterWrappers(shape.pattern);
  const inside = splitSlots(filtered.inner);
  if (inside.length > 1) {
    const outer: Outer = {
      extract: shape.extract,
      rank: shape.rank,
      filters: [],
    };
    // A predicate is distributed by rewriting the *text* around each slot,
    // not by copying the parsed spec onto it. The worker is handed
    // `shape.pattern` and peels the predicates itself, so a slot whose text had
    // lost its wrapper searched unfiltered — `{palindrome:A{5};A{6}}` answered
    // "of the" and "and the", which are not palindromes. Rewriting the text
    // means every slot reaches the worker looking exactly like the single-slot
    // query it is.
    const at = shape.pattern.indexOf(filtered.inner);
    if (at >= 0) {
      const before = shape.pattern.slice(0, at);
      const after = shape.pattern.slice(at + filtered.inner.length);
      const outerKinds = new Set<FilterSpec["kind"]>(
        filtered.specs.map((f) => f.kind),
      );
      return inside.map((part) => {
        // A slot that restates one of the outer predicates keeps its own text
        // untouched. Wrapping it anyway would produce
        // `{palindrome:{palindrome:A{7}}}`, which the language refuses as
        // "applied twice" — and the rule everywhere else is that a slot which
        // says something means it, the outer wrapper being the default. Same as
        // `{at …}`, where a slot's own position wins without complaint.
        const restates = ownKinds(part, minLiteralChars).some((k) =>
          outerKinds.has(k),
        );
        const text = restates ? part : `${before}${part}${after}`;
        return planOne(text, minLiteralChars, outer);
      });
    }
    return inside.map((part) => planOne(part, minLiteralChars, outer));
  }

  return [planOne(top[0] ?? query, minLiteralChars, NOTHING_OUTSIDE)];
}
