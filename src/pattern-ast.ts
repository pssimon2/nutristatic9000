// The pattern as a tree, for the one consumer that cannot use an automaton:
// exact re-verification of a finished match (span-verify.ts).
//
// The search never sees this. It runs on the compiled conjuncts as before, and
// a predicate written inside a pattern contributes only its argument's
// automaton — its *hull* — to that search. The tree exists so that, per
// candidate the hull lets through, the match can be parsed again exactly, with
// every predicate asked of the span its node covers. That is what lets a
// predicate sit at any depth: `{palindrome:A{5}} {kind:bird}` is a `seq` whose
// first child is a `pred`, and the verifier finds which prefix the palindrome
// must hold of.
//
// Any subtree with no predicate below it is collapsed to an `nfa` leaf holding
// the very conjuncts the compiler built for it — so on predicate-free ground
// the verifier and the search cannot disagree about what the language is;
// structure is kept only where a predicate makes it necessary.

import type { Conjunct } from "./conjunct.js";
import type { FilterSpec } from "./result-filter.js";

export type PatternAst =
  /** A predicate-free fragment: the intersection of these conjuncts. */
  | { t: "nfa"; and: Conjunct[] }
  | { t: "seq"; parts: PatternAst[] }
  | { t: "alt"; parts: PatternAst[] }
  | { t: "and"; parts: PatternAst[] }
  | { t: "not"; inner: PatternAst }
  /** min..max repetitions; max is Infinity for `*` and `+`. */
  | { t: "rep"; inner: PatternAst; min: number; max: number }
  /** A `<…>` anagram: `parts` in any order, each used `count` times. */
  | { t: "anagram"; parts: Array<{ ast: PatternAst; count: number }> }
  /** A predicate over the span its inner pattern covers. */
  | { t: "pred"; spec: FilterSpec; inner: PatternAst };

/** Does any node below (or at) this one carry a predicate? */
export function hasPred(ast: PatternAst): boolean {
  switch (ast.t) {
    case "nfa":
      return false;
    case "pred":
      return true;
    case "not":
    case "rep":
      return hasPred(ast.inner);
    case "anagram":
      return ast.parts.some((p) => hasPred(p.ast));
    default:
      return ast.parts.some(hasPred);
  }
}
