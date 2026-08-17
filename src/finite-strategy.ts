// Answering a query by testing a list instead of walking the index.
//
// `{rhyme:night}&A{5}` is two conjuncts, and they are not alike. One is a
// hundred and three specific words; the other is "any five letters". The
// search treats them the same — it walks the trie best-first and intersects
// both automata at every node — which means paying for a walk over the whole
// index to find answers that were enumerable from the start.
//
// The other way round is: take the hundred and three words, test each against
// the rest of the query (a few microseconds each, no index at all), ask the
// index what the survivors are worth, and sort. The index is touched once per
// survivor rather than once per node visited.
//
// **When this is exactly the same answer.** A result the walk produces is
// either one index entry or several joined at a space — the "restart"
// mechanism, which scales the score by a factor each time it fires. A probe
// knows nothing about that: it can price a single entry and not a join. So
// this only runs when every candidate is free of spaces, since a string with
// no space cannot be a join, and then the probe's count *is* the score the
// walk would report. That is checked against the walk in the tests rather
// than argued from here.
//
// It costs a probe per survivor, which over a streamed index is a handful of
// round trips each. That is the trade: a bounded number of round trips
// against an unbounded walk.

import type { Conjunct } from "./conjunct.js";
import type { IndexReader } from "./index-reader.js";
import { Nfa, trim } from "./automata.js";
import { innerNfa, isNegated } from "./conjunct.js";
import { makeFilter } from "./expr-filter.js";
import { probeCount } from "./index-probe.js";

/** Most candidates worth enumerating: past this the walk is the better tool. */
export const CANDIDATE_CAP = 5000;

/**
 * Most survivors worth probing.
 *
 * Every survivor costs an index lookup, and they are all paid before the first
 * result is shown — where the walk streams. A short list answered outright
 * beats a walk; a long one answered outright is a long silence, so past this
 * the walk is the better tool even though this would still be correct.
 */
export const PROBE_LIMIT = 400;

/**
 * Every string an acyclic NFA accepts, or null if there are more than `cap`
 * of them or the automaton has a cycle.
 *
 * Depth-first over the trimmed graph. Epsilon arcs (label 0) add no character,
 * which is also how a cycle of them would fail to terminate — hence the visit
 * set, which is per-path rather than global: two paths may legitimately reach
 * the same state having spelled different things.
 *
 * Distinct strings, not distinct paths. An automaton often accepts the same
 * string more than one way — `{del1:{list:greek}}` reaches "gama" by deleting
 * either M of GAMMA — and a caller wants the language, not a walk of the
 * graph. Returning paths made the strategy emit "gama" twice where the search
 * emits it once, which is how this was found.
 */
export function enumerateLanguage(
  input: Nfa,
  cap: number = CANDIDATE_CAP,
): string[] | null {
  const nfa = trim(input);
  if (nfa.start === -1 || nfa.arcs.length === 0) return [];
  const out = new Set<string>();
  const onPath = new Set<number>();

  const walk = (s: number, acc: string): boolean => {
    if (out.size > cap) return false;
    if (nfa.finals.has(s)) out.add(acc);
    if (onPath.has(s)) return false; // a cycle: not a finite language
    onPath.add(s);
    for (const arc of nfa.arcs[s]) {
      const next =
        arc.label === 0 ? acc : acc + String.fromCharCode(arc.label);
      if (!walk(arc.to, next)) {
        onPath.delete(s);
        return false;
      }
    }
    onPath.delete(s);
    return true;
  };

  if (!walk(nfa.start, "")) return null;
  return out.size > cap ? null : [...out];
}

export interface FiniteCandidates {
  /** Which conjunct was enumerated, by position. */
  index: number;
  /** Its language, with the trailing boundary space trimmed off. */
  strings: string[];
}

/**
 * The smallest conjunct worth enumerating, or null if none is.
 *
 * Smallest because the whole point is to test few things: given
 * `{list:greek}&{kind:bird}` there is no reason to walk 1,761 birds when
 * 24 Greek letters will do.
 *
 * A negated conjunct is never chosen — its language is the complement, which
 * is enormous even when what it complements is tiny.
 */
export function finiteCandidates(
  conjuncts: Conjunct[],
  cap: number = CANDIDATE_CAP,
): FiniteCandidates | null {
  let best: FiniteCandidates | null = null;
  for (let i = 0; i < conjuncts.length; ++i) {
    const c = conjuncts[i];
    if (isNegated(c)) continue;
    const strings = enumerateLanguage(innerNfa(c), cap);
    if (strings === null || strings.length === 0) continue;
    // Compiled conjuncts carry the boundary space the search requires; the
    // results are reported without it.
    const trimmed = strings.map((s) => s.replace(/ $/, ""));
    // A candidate containing a space might be several index entries joined at
    // one, which this cannot price. See the note at the top.
    if (trimmed.some((s) => s.includes(" "))) continue;
    if (best === null || trimmed.length < best.strings.length) {
      best = { index: i, strings: trimmed };
    }
  }
  return best;
}

export interface FiniteResult {
  text: string;
  score: number;
}

/**
 * What testing this query would cost, without touching the index.
 *
 * Both numbers are free to work out — enumerating an automaton and running
 * strings through a filter are memory operations — which is what lets the
 * plan say which strategy will run before anything is searched.
 */
export function testPlan(
  conjuncts: Conjunct[],
  cap: number = CANDIDATE_CAP,
): { candidates: number; survivors: number } | null {
  const found = finiteCandidates(conjuncts, cap);
  if (found === null) return null;
  const rest = conjuncts.filter((_, i) => i !== found.index);
  const filter = rest.length > 0 ? makeFilter(rest) : null;
  const survivors = filter
    ? found.strings.filter((t) => accepts(filter, `${t} `)).length
    : found.strings.length;
  if (survivors > PROBE_LIMIT) return null;
  return { candidates: found.strings.length, survivors };
}

/**
 * Run the query by testing candidates, or return null if that does not apply.
 *
 * Null means "use the walk" and is the common answer: most queries have no
 * small finite conjunct, and many that do have one full of phrases.
 */
export async function finiteStrategy(
  reader: IndexReader,
  conjuncts: Conjunct[],
  cap: number = CANDIDATE_CAP,
): Promise<FiniteResult[] | null> {
  const candidates = finiteCandidates(conjuncts, cap);
  if (candidates === null) return null;

  // Everything except the conjunct being enumerated, as one filter. The
  // candidates already satisfy that one by construction.
  const rest = conjuncts.filter((_, i) => i !== candidates.index);
  const filter = rest.length > 0 ? makeFilter(rest) : null;

  // Testing costs nothing and probing costs a round trip, so everything is
  // tested first and the decision to probe is made knowing how many there are.
  const survivors = filter
    ? candidates.strings.filter((t) => accepts(filter, `${t} `))
    : candidates.strings;
  if (survivors.length > PROBE_LIMIT) return null;

  const out: FiniteResult[] = [];
  for (const text of survivors) {
    const score = await probeCount(reader, text);
    // Not in the index: the walk could not have produced it either.
    if (score > 0) out.push({ text, score });
  }
  // Best-first, which is the order the walk emits in.
  out.sort((a, b) => b.score - a.score);
  return out;
}

function accepts(
  filter: ReturnType<typeof makeFilter>,
  text: string,
): boolean {
  let state = filter.startState;
  for (let i = 0; i < text.length; ++i) {
    state = filter.transition(state, text.charCodeAt(i));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}
