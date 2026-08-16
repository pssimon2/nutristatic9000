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
 * nothing" and "these two cannot both be true". It is only possible when the
 * query's textual conjuncts line up one-to-one with the compiled ones, which
 * a plain intersection does and a construct expanding into several does not —
 * `{sum=52:A*}` is four conjuncts written as one, and guessing which text goes
 * with which automaton would mislabel them. Then it returns null and the
 * caller says the shorter thing.
 */
export function conflictText(
  query: string,
  ctx: SessionContext,
): string[] | null {
  let conjuncts: Conjunct[];
  let sources: string[];
  try {
    conjuncts = compileConjuncts(query, ctx);
    sources = topLevelConjuncts(query);
  } catch {
    return null; // it did not compile; that is a different message
  }
  if (sources.length !== conjuncts.length) return null;
  const indices = conflictingConjuncts(conjuncts);
  if (!indices) return null;
  return indices.map((i) => sources[i]);
}
