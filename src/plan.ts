// What the engine is about to do, before it does it.
//
// A slow query looks exactly like a fast one from outside. `--explain` says
// which conjuncts a query became, how big each one's automaton is, and — the
// part that usually answers the question — whether each describes a *finite*
// set of strings or an unbounded one.
//
// That distinction is the difference between a search that ends and one that
// wanders: `{list:countries}` is 197 strings and the walk stops when they are
// exhausted, while `A*` is infinite and only a length or a value ceiling
// bounds it. The roadmap's planner (Phase P) wants to *choose strategies* from
// this; the numbers themselves are useful long before anything acts on them.

import { Nfa, trim } from "./automata.js";
import { innerNfa, isNegated } from "./conjunct.js";
import { compileConjuncts } from "./find-expr.js";
import { makeFilter } from "./expr-filter.js";
import { SessionContext } from "./session-context.js";
import { topLevelConjuncts } from "./explain.js";
import { shapeOfQuery } from "./query-shape.js";
import { parseFilterWrapper } from "./result-filter.js";
import { needsCategories } from "./categories.js";
import { needsPhonetics } from "./phonetics.js";
import { needsStress } from "./stress.js";
import { needsThesaurus } from "./thesaurus.js";
import { needsNeighbours } from "./neighbours.js";
import { needsWikiLists } from "./word-lists.js";

/** Above this the count is reported as "many" rather than enumerated. */
const COUNT_CAP = 1_000_000;

export interface ConjunctPlan {
  /** The query fragment this came from, when the split lines up. */
  source: string | null;
  /**
   * True when the conjunct is a complement, walked lazily at search time. Its
   * measurements below describe the automaton being complemented, which is
   * what determines the cost — the complement itself is never built.
   */
  negated: boolean;
  states: number;
  arcs: number;
  /** False when the automaton has a reachable, productive cycle. */
  finite: boolean;
  /** Strings in the language, when finite and below the cap. */
  size: number | null;
}

export interface QueryPlan {
  /** The pattern the engine sees, wrappers peeled. */
  pattern: string;
  conjuncts: ConjunctPlan[];
  /** One conjunct compiles to a plain lazy DFA; several to a lazy product. */
  filterKind: "single" | "product" | "empty";
  /** The whole-query result filter, if any — checked per match, not searched. */
  predicate: string | null;
  /** Output wrappers, outermost first. */
  transforms: string[];
  /** Side datasets this query needs loaded before it can compile. */
  dataNeeds: string[];
}

const SPACE = " ".charCodeAt(0);

/**
 * Arcs that only pad a match with spaces, which every unquoted literal
 * carries: `parseAtom` adds a space self-loop at each end so `solar s_stem`
 * tolerates the corpus's spacing.
 *
 * They make almost every language infinite in the strict sense, which is true
 * and useless — reporting "unbounded" for `solar s_stem` explains nothing.
 * Finiteness here means the *letter* sequences are bounded.
 */
const isSpacePadding = (from: number, label: number, to: number) =>
  from === to && label === SPACE;

/**
 * Is the language finite, and if so how big?
 *
 * Finite ⇔ no cycle among the states that can both be reached from the start
 * and reach a final; a cycle elsewhere is unreachable or dead and cannot
 * generate anything. Counting is then a DP over the acyclic graph, capped
 * because an acyclic automaton can still describe astronomically many
 * strings.
 */
export function languageSize(input: Nfa): { finite: boolean; size: number | null } {
  const nfa = trim(input);
  const n = nfa.arcs.length;
  if (n === 0 || nfa.start === -1) return { finite: true, size: 0 };

  // Cycle detection over the trimmed graph, epsilon arcs included: an epsilon
  // loop is still a loop, though it adds no characters.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Uint8Array(n);
  let cyclic = false;
  const stack: Array<{ s: number; i: number }> = [];
  for (let root = 0; root < n && !cyclic; ++root) {
    if (colour[root] !== WHITE) continue;
    stack.push({ s: root, i: 0 });
    colour[root] = GREY;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const arcs = nfa.arcs[top.s];
      if (top.i >= arcs.length) {
        colour[top.s] = BLACK;
        stack.pop();
        continue;
      }
      const arc = arcs[top.i++];
      const to = arc.to;
      if (isSpacePadding(top.s, arc.label, to)) continue;
      if (colour[to] === GREY) {
        cyclic = true;
        break;
      }
      if (colour[to] === WHITE) {
        colour[to] = GREY;
        stack.push({ s: to, i: 0 });
      }
    }
  }
  if (cyclic) return { finite: false, size: null };

  // Paths to a final, memoised. Acyclic, so a plain recursion terminates.
  const memo = new Float64Array(n).fill(-1);
  const count = (s: number): number => {
    if (memo[s] >= 0) return memo[s];
    memo[s] = 0; // guards against a cycle we somehow missed
    let total = nfa.finals.has(s) ? 1 : 0;
    for (const arc of nfa.arcs[s]) {
      if (isSpacePadding(s, arc.label, arc.to)) continue;
      total += count(arc.to);
      if (total > COUNT_CAP) break;
    }
    memo[s] = total;
    return total;
  };
  const total = count(nfa.start);
  return { finite: true, size: total > COUNT_CAP ? null : total };
}

function arcCount(nfa: Nfa): number {
  let n = 0;
  for (const list of nfa.arcs) n += list.length;
  return n;
}

/** Which side datasets the query needs; the same sniffers the worker uses. */
function dataNeedsOf(query: string): string[] {
  const needs: string[] = [];
  if (needsPhonetics(query)) needs.push("phonetics");
  if (needsStress(query)) needs.push("stress");
  if (needsCategories(query)) needs.push("categories");
  if (needsNeighbours(query)) needs.push("neighbours");
  if (needsThesaurus(query)) needs.push("thesaurus");
  if (needsWikiLists(query)) needs.push("lists");
  return needs;
}

/** Analyse a query without searching it. Throws what compiling would throw. */
export function planQuery(query: string, ctx: SessionContext): QueryPlan {
  const transforms: string[] = [];
  const shaped = shapeOfQuery(query, 12);
  if (shaped.extract) transforms.push("at");
  if (shaped.rank) transforms.push("rank");

  let pattern = shaped.pattern;
  let predicate: string | null = null;
  const wrapper = parseFilterWrapper(pattern);
  if (wrapper) {
    predicate = wrapper.spec.kind;
    pattern = wrapper.inner;
  }

  const compiled = compileConjuncts(pattern, ctx);
  // The textual split lines up with the compiled conjuncts only when the query
  // is a plain intersection; anything else (a union, a construct expanding to
  // several) does not, and guessing would mislabel them.
  const sources = topLevelConjuncts(pattern);
  const aligned = sources.length === compiled.length ? sources : null;

  const conjuncts = compiled.map((c, i) => {
    const nfa = innerNfa(c);
    const { finite, size } = languageSize(nfa);
    return {
      source: aligned ? aligned[i] : null,
      negated: isNegated(c),
      states: nfa.arcs.length,
      arcs: arcCount(nfa),
      finite,
      size,
    };
  });

  return {
    pattern,
    conjuncts,
    filterKind:
      compiled.length === 0
        ? "empty"
        : compiled.length === 1
          ? "single"
          : "product",
    predicate,
    transforms,
    dataNeeds: dataNeedsOf(query),
  };
}

/** The plan as lines a person can read. */
export function formatPlan(plan: QueryPlan): string[] {
  const out: string[] = [];
  out.push(`pattern: ${plan.pattern}`);
  out.push(
    `${plan.conjuncts.length} conjunct${plan.conjuncts.length === 1 ? "" : "s"}` +
      ` (${plan.filterKind === "product" ? "lazy product" : "lazy DFA"})`,
  );
  plan.conjuncts.forEach((c, i) => {
    const language = c.finite
      ? c.size === null
        ? "finite, very large"
        : `finite, ${c.size.toLocaleString("en-US")} string${c.size === 1 ? "" : "s"}`
      : "unbounded";
    out.push(
      `  [${i}] ${c.negated ? "NOT " : ""}${c.states} states, ${c.arcs} arcs` +
        ` — ${language}${c.source ? `   ${c.source}` : ""}`,
    );
  });
  if (plan.predicate) {
    out.push(`predicate: ${plan.predicate} (checked per match, not searched)`);
  }
  if (plan.transforms.length > 0) {
    out.push(`transforms: ${plan.transforms.join(", ")}`);
  }
  if (plan.dataNeeds.length > 0) {
    out.push(`needs: ${plan.dataNeeds.join(", ")}`);
  }
  // The observation that most often explains a slow query.
  if (plan.conjuncts.length > 0 && plan.conjuncts.every((c) => !c.finite)) {
    out.push(
      "note: every conjunct is unbounded — the walk is limited only by the " +
        "step budget. A length or a value ceiling would bound it.",
    );
  }
  return out;
}

/** Compile the plan's pattern into the filter the driver would use. */
export function filterFor(plan: QueryPlan, ctx: SessionContext) {
  return makeFilter(compileConjuncts(plan.pattern, ctx));
}
