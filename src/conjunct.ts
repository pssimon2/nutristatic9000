// What a query compiles to: a list of things that must *all* hold.
//
// Until now every conjunct was an NFA, so the list was `Nfa[]` and the whole
// pipeline — the parser's Box, the product filter, the WASM kernel, the
// planner — could assume it. Negation broke that assumption. `complement()`
// has to determinize before it can flip acceptance, and while determinizing is
// what makes complementation possible it is also what makes it expensive: the
// automaton for `{distinct:A{6}}` is 98,575 states, already deterministic, and
// materializing its complement as an NFA costs about a gigabyte of arcs that
// the search then visits a few thousand of.
//
// So a conjunct is now either an NFA or the *negation* of one, left
// unmaterialized. `ComplementFilter` walks it lazily during the search, which
// is the same trick `ExprFilter` already plays on intersection: build only the
// states the index actually reaches.

import { Nfa } from "./automata.js";

/** A conjunct whose language is the complement of `not`'s. */
export interface Negated {
  readonly not: Nfa;
}

/** One member of the intersection a query compiles to. */
export type Conjunct = Nfa | Negated;

export function isNegated(c: Conjunct): c is Negated {
  return !(c instanceof Nfa);
}

/**
 * The NFA inside a conjunct — the language itself, or the language being
 * complemented. For anything that measures a conjunct rather than deciding
 * membership (state counts, arc counts, the planner's size estimates).
 */
export function innerNfa(c: Conjunct): Nfa {
  return isNegated(c) ? c.not : c;
}
