// Does this pattern match anything at all?
//
// `A{5}&A{6}` cannot. Nothing is five letters and six letters. But the search
// had no way to know that: both halves accept every prefix, so the walk
// descends the whole trie looking for a word that satisfies both, spends the
// entire million-step budget, finds nothing, and the page then offers a "Try
// harder" button — inviting the user to spend it again. Over a range-mode
// index that is also tens of megabytes fetched for an answer that was
// available before the first byte.
//
// The automaton knows. A pattern matches nothing exactly when no accepting
// state is reachable from the start, and that is a search over the *filter*
// rather than the index — over DFA states, of which there are usually a
// handful, not over strings, of which there are 37^n. `A{5}&A{6}` settles in
// about forty states.
//
// It is deliberately a three-way answer. Proving emptiness means visiting
// every reachable state, and some patterns have hundreds of thousands
// ({distinct:A{6}} does), which is the same explosion the lazy filters exist
// to avoid. So the walk is bounded, and past the bound it reports "unknown"
// and the search proceeds as before. A wrong "empty" would hide real results;
// "unknown" only costs what the search cost already.

import { ALPHABET } from "./automata.js";
import { Filter, conjunctFilter, makeFilter } from "./expr-filter.js";
import { Conjunct } from "./conjunct.js";
import { compileConjuncts } from "./find-expr.js";
import { topLevelConjuncts } from "./explain.js";
import { SessionContext } from "./session-context.js";

/** Whether a pattern can match, when that is cheap enough to determine. */
export type Emptiness = "empty" | "matches" | "unknown";

/**
 * States the walk may visit before giving up.
 *
 * Small on purpose. A contradiction is *cheap* to prove — the automaton runs
 * out of reachable states almost immediately, and every contradiction worth
 * catching (`A{5}&A{6}` at ~40 states, two disagreeing `{sum}`s at a few
 * hundred) settles well under 500. What needs tens of thousands of states is a
 * large *satisfiable* automaton, which is precisely the case where the check
 * has nothing to contribute and the search will find results on its own.
 *
 * So the budget is set by what a proof costs, not by what an automaton can
 * cost. Raising it buys almost nothing and makes every search pre-build lazy
 * DFA states it may never visit — at 20,000 the multiset benchmark interned
 * 5,946 extra, against 45 for the whole rest of the grid.
 */
export const EMPTINESS_BUDGET = 2000;

/**
 * Can `filter` accept anything?
 *
 * Breadth-first over reachable DFA states — each visited once, so the cost is
 * states × alphabet, not paths. Stops at the first accepting state, which is
 * why the answer for an ordinary pattern is immediate.
 */
export function languageEmptiness(
  filter: Filter,
  budget = EMPTINESS_BUDGET,
): Emptiness {
  const seen = new Set<number>([filter.startState]);
  let frontier = [filter.startState];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const state of frontier) {
      if (filter.isAccepting(state)) return "matches";
      for (const ch of ALPHABET) {
        const to = filter.transition(state, ch);
        if (to < 0 || seen.has(to)) continue;
        if (seen.size >= budget) return "unknown";
        seen.add(to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return "empty";
}

/**
 * Which parts of an intersection cannot hold together.
 *
 * Knowing a pattern matches nothing is worth saying; knowing *which two* of
 * its parts disagree is what lets someone fix it. Single conjuncts are tested
 * first (one part that matches nothing on its own is the whole story), then
 * pairs, so the answer is the smallest set that is already contradictory
 * rather than the whole query.
 *
 * Returns the indices of the conflicting conjuncts, or null when the conflict
 * needs three or more of them — which is real (`A{5}&C*&V*` needs all three)
 * but not worth an exponential search to name.
 */
export function conflictingConjuncts(
  conjuncts: Conjunct[],
  budget = EMPTINESS_BUDGET,
): number[] | null {
  const filters = conjuncts.map(conjunctFilter);
  for (let i = 0; i < filters.length; ++i) {
    if (languageEmptiness(filters[i], budget) === "empty") return [i];
  }
  // Pairs only. With n conjuncts this is n(n-1)/2 bounded walks, and it runs
  // only once the whole pattern is already known to match nothing — a rare
  // enough case to afford it, and `{distinct:…}`-sized conjunct lists give up
  // on the budget rather than grinding.
  for (let i = 0; i < conjuncts.length; ++i) {
    for (let j = i + 1; j < conjuncts.length; ++j) {
      const pair = makeFilter([conjuncts[i], conjuncts[j]]);
      if (languageEmptiness(pair, budget) === "empty") return [i, j];
    }
  }
  return null;
}

/**
 * Why a query matches nothing, in the words the user wrote.
 *
 * Naming the two parts that disagree is the difference between "this finds
 * nothing" and "these two cannot both be true". The parts are the ones
 * *written* — split on `&` — and each is compiled on its own, because a
 * construct is rarely one automaton: `{bank:washington}` is a per-letter
 * bound for each of its nine distinct letters, so pairing compiled conjuncts
 * with written ones by position only works for a query made entirely of bare
 * patterns. Compiling each written part separately keeps the two aligned by
 * construction, and is what lets the commonest kind of impossible query —
 * a construct against a length — say which two parts it means.
 */
export function conflictText(
  query: string,
  ctx: SessionContext,
): string[] | null {
  const sources = topLevelConjuncts(query);
  if (sources.length < 2) return null; // one part cannot contradict another
  const compiled: Conjunct[][] = [];
  for (const source of sources) {
    try {
      compiled.push(compileConjuncts(source, ctx));
    } catch {
      return null; // a part that does not stand alone; say the shorter thing
    }
  }

  // A part that matches nothing by itself is the whole story.
  for (let i = 0; i < compiled.length; ++i) {
    if (languageEmptiness(makeFilter(compiled[i])) === "empty") {
      return [sources[i]];
    }
  }
  for (let i = 0; i < compiled.length; ++i) {
    for (let j = i + 1; j < compiled.length; ++j) {
      const pair = makeFilter([...compiled[i], ...compiled[j]]);
      if (languageEmptiness(pair) === "empty") return [sources[i], sources[j]];
    }
  }
  return null;
}
