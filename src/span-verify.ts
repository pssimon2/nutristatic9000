// Exact re-verification of a finished match against a pattern whose
// predicates may sit at any depth.
//
// The search runs on hulls: a predicate node contributes only its argument's
// automaton, so everything the index walk emits is a candidate, not an answer.
// This module is the other half of that bargain. It parses the candidate
// against the pattern's tree (pattern-ast.ts) and asks each predicate of
// exactly the span its node covers — a match survives if SOME parse assigns
// spans that satisfy every predicate ("exists-a-parse" semantics, the one a
// reader expects: it matches if it can match).
//
// Why this is affordable when the search-side question is not: a finished
// match is a short string. Every set here is a set of *end positions* within
// it, so the whole evaluation is a memoised pass over (node × start position),
// each entry a handful of positions — the hard theory about non-regular
// languages applies to infinite sets, and none live here.
//
// The evaluation is exact even on predicate-free ground, because those
// subtrees arrive as the very conjuncts the compiler built (an `nfa` leaf) and
// are decided by simulating them — the verifier and the search share one
// definition of the language wherever both have one.

import { EPSILON, Nfa } from "./automata.js";
import { isNegated } from "./conjunct.js";
import type { FilterSpec } from "./result-filter.js";
import type { PatternAst } from "./pattern-ast.js";

/**
 * One predicate, asked of one span. Injected rather than imported: the
 * implementation lives in result-predicate.ts, which calls back in here for
 * `where` — passing the function breaks the cycle and hands the verifier the
 * session's context and index probe without holding either.
 */
export type PredicateCheck = (
  spec: FilterSpec,
  span: string,
) => Promise<{ keep: boolean; note: string | null }>;

/**
 * End positions reachable from a given start, each with the notes collected
 * along the first witness parse that reached it.
 */
type Ends = Map<number, string[]>;

export interface SpanVerdict {
  keep: boolean;
  /** Notes from the nested predicates of the accepting parse, in span order. */
  notes: string[];
}

/** Does `text`, in full, belong to the pattern's exact language? */
export async function verifyMatch(
  ast: PatternAst,
  text: string,
  check: PredicateCheck,
): Promise<SpanVerdict> {
  const n = text.length;
  const memo = new Map<PatternAst, Map<number, Promise<Ends>>>();

  const ends = (node: PatternAst, i: number): Promise<Ends> => {
    let perNode = memo.get(node);
    if (perNode === undefined) {
      perNode = new Map();
      memo.set(node, perNode);
    }
    const cached = perNode.get(i);
    if (cached !== undefined) return cached;
    const computed = endsOf(node, i);
    perNode.set(i, computed);
    return computed;
  };

  const endsOf = async (node: PatternAst, i: number): Promise<Ends> => {
    switch (node.t) {
      case "nfa": {
        // The intersection of the leaf's conjuncts, a negated conjunct
        // contributing the complement of what its automaton reaches.
        let live: Set<number> | null = null;
        for (const c of node.and) {
          const reached = simulateEnds(isNegated(c) ? c.not : c, text, i);
          const mine = new Set<number>();
          for (let j = i; j <= n; ++j) {
            if (isNegated(c) !== reached.has(j)) mine.add(j);
          }
          if (live === null) {
            live = mine;
          } else {
            for (const j of live) if (!mine.has(j)) live.delete(j);
          }
          if (live.size === 0) break;
        }
        const out: Ends = new Map();
        // An empty conjunct list is the identity of intersection: everything.
        for (const j of live ?? allPositions(i, n)) out.set(j, []);
        return out;
      }
      case "seq": {
        let frontier: Ends = new Map([[i, []]]);
        for (const part of node.parts) {
          const next: Ends = new Map();
          for (const [j, notes] of frontier) {
            for (const [k, more] of await ends(part, j)) {
              if (!next.has(k)) next.set(k, notes.concat(more));
            }
          }
          frontier = next;
          if (frontier.size === 0) break;
        }
        return frontier;
      }
      case "alt": {
        const out: Ends = new Map();
        for (const part of node.parts) {
          for (const [j, notes] of await ends(part, i)) {
            if (!out.has(j)) out.set(j, notes);
          }
        }
        return out;
      }
      case "and": {
        let out: Ends | null = null;
        for (const part of node.parts) {
          const mine = await ends(part, i);
          if (out === null) {
            out = new Map(mine);
          } else {
            for (const [j, notes] of [...out]) {
              const also = mine.get(j);
              if (also === undefined) out.delete(j);
              else out.set(j, notes.concat(also));
            }
          }
          if (out.size === 0) break;
        }
        return out ?? new Map();
      }
      case "not": {
        const inside = await ends(node.inner, i);
        const out: Ends = new Map();
        for (const j of allPositions(i, n)) {
          if (!inside.has(j)) out.set(j, []);
        }
        return out;
      }
      case "rep": {
        const out: Ends = new Map();
        if (node.min === 0) out.set(i, []);
        let frontier: Ends = new Map([[i, []]]);
        // Enough repetitions to both reach `min` and, past it, visit every
        // position empty repetitions could ever unlock: each round beyond a
        // fixpoint adds a position or nothing, and there are at most n-i+1.
        const cap = Math.min(node.max, node.min + (n - i) + 2);
        for (let k = 1; k <= cap; ++k) {
          const next: Ends = new Map();
          for (const [j, notes] of frontier) {
            for (const [e, more] of await ends(node.inner, j)) {
              if (!next.has(e)) next.set(e, notes.concat(more));
            }
          }
          frontier = next;
          if (frontier.size === 0) break;
          if (k >= node.min) {
            let grew = false;
            for (const [e, notes] of frontier) {
              if (!out.has(e)) {
                out.set(e, notes);
                grew = true;
              }
            }
            // Once collecting, a round that adds nothing starts a cycle of
            // rounds that add nothing: every later frontier is built from
            // positions already collected.
            if (!grew && k > node.min) break;
          }
        }
        return out;
      }
      case "anagram": {
        // A sequence of pieces in any order, each part used exactly its
        // count: a DP over (position, what is still owed).
        const parts = node.parts;
        const seen = new Map<string, Ends>();
        const go = async (pos: number, counts: number[]): Promise<Ends> => {
          const key = `${pos}|${counts.join(",")}`;
          const known = seen.get(key);
          if (known !== undefined) return known;
          const out: Ends = new Map();
          if (counts.every((c) => c === 0)) {
            out.set(pos, []);
          } else {
            for (let pi = 0; pi < parts.length; ++pi) {
              if (counts[pi] === 0) continue;
              const remaining = counts.slice();
              --remaining[pi];
              for (const [j, notes] of await ends(parts[pi].ast, pos)) {
                for (const [e, more] of await go(j, remaining)) {
                  if (!out.has(e)) out.set(e, notes.concat(more));
                }
              }
            }
          }
          seen.set(key, out);
          return out;
        };
        return go(i, parts.map((p) => p.count));
      }
      case "pred": {
        const out: Ends = new Map();
        for (const [j, notes] of await ends(node.inner, i)) {
          const verdict = await check(node.spec, text.slice(i, j));
          if (!verdict.keep) continue;
          out.set(j, verdict.note === null ? notes : [...notes, verdict.note]);
        }
        return out;
      }
    }
  };

  const reached = await ends(ast, 0);
  const notes = reached.get(n);
  return notes === undefined
    ? { keep: false, notes: [] }
    : { keep: true, notes };
}

function allPositions(i: number, n: number): number[] {
  const out: number[] = [];
  for (let j = i; j <= n; ++j) out.push(j);
  return out;
}

/**
 * The end positions at which `nfa`, started at `i`, is in an accepting state —
 * a plain NFA simulation over the tail of the text, epsilon closure included.
 */
function simulateEnds(nfa: Nfa, text: string, i: number): Set<number> {
  const out = new Set<number>();
  if (nfa.start === -1) return out;
  let states = closure(nfa, new Set([nfa.start]));
  for (let pos = i; ; ++pos) {
    for (const s of states) {
      if (nfa.finals.has(s)) {
        out.add(pos);
        break;
      }
    }
    if (pos >= text.length) break;
    const code = text.charCodeAt(pos);
    const next = new Set<number>();
    for (const s of states) {
      for (const arc of nfa.arcs[s]) {
        if (arc.label === code) next.add(arc.to);
      }
    }
    if (next.size === 0) break;
    states = closure(nfa, next);
  }
  return out;
}

/** All states reachable from `states` over epsilon arcs, `states` included. */
function closure(nfa: Nfa, states: Set<number>): Set<number> {
  const out = new Set(states);
  const stack = [...states];
  while (stack.length > 0) {
    const s = stack.pop()!;
    for (const arc of nfa.arcs[s]) {
      if (arc.label === EPSILON && !out.has(arc.to)) {
        out.add(arc.to);
        stack.push(arc.to);
      }
    }
  }
  return out;
}
