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
import { ParseError } from "./parse-error.js";
import { type SlotPlan, planSlots } from "./slot-plan.js";
import { providersFor } from "./data-providers.js";
import { testPlan } from "./finite-strategy.js";

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
  /** The slot as written, when the query has more than one. */
  slot: string | null;
  /** The pattern the engine sees, wrappers peeled. */
  pattern: string;
  conjuncts: ConjunctPlan[];
  /** One conjunct compiles to a plain lazy DFA; several to a lazy product. */
  filterKind: "single" | "product" | "empty";
  /**
   * The result filters — checked per match, not searched. Plural since C1
   * made them stack: `{palindrome:{syllables=1:A{3}}}` is two.
   */
  predicates: string[];
  /** Output wrappers, outermost first. */
  transforms: string[];
  /** Side datasets this query needs loaded before it can compile. */
  dataNeeds: string[];
  /**
   * How this slot will actually be answered.
   *
   * "test" enumerates a small finite conjunct and tests each string against
   * the rest, touching the index once per survivor; "walk" is the best-first
   * trie search. Which one runs is decided by the same function that decides
   * it at search time, so the plan cannot describe a strategy the search then
   * declines to use.
   */
  strategy:
    | { kind: "walk" }
    | { kind: "test"; candidates: number; survivors: number };
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
/**
 * The side datasets this query needs, from the one table that knows them.
 *
 * This was a seventh hand-written list of the six datasets, in the same shape
 * and the same order as the others — which is exactly how five of them came to
 * disagree about whether a construct may carry its group prefix.
 */
function dataNeedsOf(query: string): string[] {
  return providersFor(query).map((p) => p.key);
}

/** Analyse a query without searching it. Throws what compiling would throw. */
/**
 * Plan every slot of a query.
 *
 * A query may be several patterns separated by `;`, and each is its own
 * search with its own conjuncts and its own cost — so each gets its own plan.
 * Planning the whole string instead fails outright: the output wrappers insist
 * on covering what they wrap, so `{at 1:A{5}};{at 2:B{6}}` came back as
 * *{at …} must wrap the whole pattern* rather than as two plans.
 */
export function planSlotQueries(
  query: string,
  ctx: SessionContext,
): QueryPlan[] {
  const slots = planSlots(query, 12);
  return slots.map((slot) => planOneSlot(slot, ctx, slots.length > 1));
}

/**
 * Plan a single-slot query.
 *
 * Kept for callers that know they have one; it is `planSlotQueries` with the
 * first plan taken, and throws the same way if the query does not parse.
 */
export function planQuery(query: string, ctx: SessionContext): QueryPlan {
  const plans = planSlotQueries(query, ctx);
  if (plans.length === 0) throw new ParseError(query);
  return plans[0];
}

function planOneSlot(
  slot: SlotPlan,
  ctx: SessionContext,
  named: boolean,
): QueryPlan {
  const transforms: string[] = [];
  if (slot.extract) transforms.push("at");
  if (slot.rank) transforms.push("rank");

  const pattern = slot.pattern;
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

  const test = testPlan(compiled);
  return {
    slot: named ? slot.query : null,
    pattern,
    conjuncts,
    filterKind:
      compiled.length === 0
        ? "empty"
        : compiled.length === 1
          ? "single"
          : "product",
    predicates: slot.filters.map((f) => f.kind),
    transforms,
    dataNeeds: dataNeedsOf(slot.query),
    strategy:
      test === null
        ? { kind: "walk" }
        : { kind: "test", candidates: test.candidates, survivors: test.survivors },
  };
}

/** The plan as lines a person can read. */
export function formatPlan(plan: QueryPlan): string[] {
  const out: string[] = [];
  if (plan.slot !== null) out.push(`slot: ${plan.slot}`);
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
  for (const predicate of plan.predicates) {
    out.push(
      predicate === "where"
        ? "predicate: nested in the pattern — each match re-parsed, " +
            "every predicate checked on the span it covers"
        : `predicate: ${predicate} (checked per match, not searched)`,
    );
  }
  if (plan.transforms.length > 0) {
    out.push(`transforms: ${plan.transforms.join(", ")}`);
  }
  if (plan.dataNeeds.length > 0) {
    out.push(`needs: ${plan.dataNeeds.join(", ")}`);
  }
  out.push(
    plan.strategy.kind === "walk"
      ? "strategy: walk the index best-first"
      : `strategy: test ${plan.strategy.candidates} candidates ` +
        `(${plan.strategy.survivors} to look up)`,
  );
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
