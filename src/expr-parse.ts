// Port of Nutrimatic expr-parse.cpp and expr-anagram.cpp: recursive-descent
// parser for the Nutrimatic pattern language.
//
// Grammar (from the website help):
//   a-z 0-9 space   literal
//   [] () {} | . ? * +   as in regexps
//   "expr"          quoted: no implicit optional spaces between atoms
//   expr&expr       intersection
//   <...>           anagram of the contained pieces
//   _  alphanumeric   #  digit   A  letter   C  consonant   V  vowel
//   -  optional space (implemented as an epsilon-or-space atom, label 0)
//
// Unless quoted, every atom gets space self-loops on its start/final states,
// making word breaks optional everywhere.
//
// Intersections (`&`, and the constraints an anagram compiles into) are kept
// as a LIST of NFA conjuncts (a Box) instead of being materialized into a
// product automaton — eager products are where big patterns explode, mostly
// into states no search ever visits. The conjunct list survives as long as
// the intersection is the whole factor (the common heavy shape, e.g.
// `(<...>&_{20})`); any composition that can't legally distribute over the
// intersection (quantifiers, unions, concatenation with variable-length
// neighbors) falls back to materializing via the eager product, preserving
// Nutrimatic semantics exactly. The search then runs on a lazy product filter
// (see expr-filter.ts).

import {
  EPSILON,
  MAX_COMPLEMENT_STATES,
  Nfa,
  complement,
  equivalent,
  intersectExprs,
  optimize,
} from "./automata.js";
import { Conjunct, isNegated } from "./conjunct.js";
import { CONSTRUCT_BUILDERS, softConjunct } from "./construct-table.js";
import { packAdvice, packConjuncts } from "./packs.js";
import { ParseError } from "./parse-error.js";
import { SessionContext } from "./session-context.js";
import { FilterError, parseFilterSpec } from "./result-filter.js";
import { isoHull, normalizeCipher } from "./isomorph.js";
import { PatternAst, hasPred } from "./pattern-ast.js";
import {
  findConstruct,
  foldName,
  isRelationName,
  levelAdvice,
  mentionsConstruct,
  namesAtLevel,
  resolveConstruct,
  suggestConstruct,
} from "./constructs.js";
import { homophonesOf, rhymesOf } from "./phonetics.js";
import { MAX_CATEGORY, kindsOf } from "./categories.js";
import { nearestTo } from "./neighbours.js";
import { relatedTo } from "./thesaurus.js";
import {
  entriesNfa,
  listNfa,
  normalizeEntry,
  suggestList,
} from "./word-lists.js";
import {
  MAX_COUNTER_STATES,
  MAX_PATTERN_LENGTH,
  bankConstraint,
  cipherNfa,
  classConstraint,
  editConstraint,
  elementsNfa,
  encodingNfa,
  morseNfa,
  namedConstraint,
} from "./value-constraint.js";

const CODE_SPACE = 0x20;

/**
 * Whether this parse also records a PatternAst on each Box, for span-verify.
 *
 * A module flag rather than a parameter because it threads through nine
 * mutually recursive functions that otherwise never look at it, and the parse
 * is fully synchronous — set in parsePatternAst, cleared in its finally, and
 * nothing can observe it in between. When off (every ordinary compile), the
 * instrumentation costs one branch per node and allocates nothing.
 */
let collectAst = false;

const PREDICATE_NAMES = namesAtLevel("predicate");

function cloneConjunct(c: Conjunct): Conjunct {
  return isNegated(c) ? { not: c.not.clone() } : c.clone();
}

/**
 * The subtree's AST: the structure parsing recorded, or — for predicate-free
 * ground — its compiled conjuncts, cloned. Cloned because a parent may later
 * materialize the box and mutate the very NFA object in `and[0]` (concat and
 * union build into their left operand); the language captured here must be the
 * one the subtree had when it was read.
 */
function astOf(box: Box): PatternAst {
  return box.ast ?? { t: "nfa", and: box.and.map(cloneConjunct) };
}

/**
 * Keep a structural node only if a predicate below it needs the structure.
 * Predicate-free subtrees fall back to their conjuncts (see astOf), so the
 * verifier and the search read the same language definition wherever both
 * have one.
 */
function keepIf(node: PatternAst): PatternAst | null {
  return hasPred(node) ? node : null;
}

/** An expression as an intersection of one or more conjuncts. */
export class Box {
  and: Conjunct[] = [];
  /** Set only while collectAst is on, and only under a predicate. */
  ast: PatternAst | null = null;

  static single(nfa: Nfa): Box {
    const box = new Box();
    box.and.push(nfa);
    return box;
  }

  /**
   * Collapse to a single NFA (eager product); cached.
   *
   * Callers are the places an NFA is structurally required and a lazy filter
   * will not do: a union, a quantifier, concatenation. A negated conjunct has
   * to be complemented for real here, which means determinizing it, which is
   * the cost the lazy path exists to avoid — so this is also the only place
   * negation can still hit a limit, and it says so.
   */
  materialize(): Nfa {
    // A weighted conjunct's weights live on its final states, and every
    // combinator here renumbers or merges finals — the weights would be
    // silently dropped. Weighted constructs are conjunct-level by design.
    for (const c of this.and) {
      if (!isNegated(c) && c.finalWeight !== undefined) {
        throw new ParseError(
          "",
          "a soft construct ({~…}) or graded {edit:…} scores matches, so it " +
            "joins the query with \"&\" (or stands alone) — it can't sit " +
            "inside a group, a union, a quantifier or a longer pattern",
        );
      }
    }
    if (this.and.some(isNegated)) {
      this.and = this.and.map((c) => {
        if (!isNegated(c)) return c;
        const done = complement(c.not);
        if (!done) {
          throw new ParseError(
            "",
            `this negation has to be built out in full here — inside a ` +
              `quantifier, a union or a longer pattern — and it is over the ` +
              `${MAX_COMPLEMENT_STATES}-state limit for that. On its own, or ` +
              `joined with "&", the same negation is checked as the search ` +
              `runs and has no limit.`,
          );
        }
        return done;
      });
    }
    if (this.and.length > 1) {
      const merged = new Nfa();
      intersectExprs(this.and as Nfa[], merged);
      this.and = [merged];
    }
    return this.and[0] as Nfa;
  }
}

function epsilonNfa(): Nfa {
  const nfa = new Nfa();
  nfa.setStart(nfa.addState());
  nfa.setFinal(nfa.start);
  return nfa;
}

/** Σ*: any string of letters, digits and spaces, including the empty one. */
function anyString(): Nfa {
  const nfa = epsilonNfa();
  const all: number[] = [];
  parseCharClass(".", 0, all);
  for (const c of all) nfa.addArc(nfa.start, c, nfa.start);
  return nfa;
}

/** Parse a full expression into `box`; returns end position or null. */
export function parseExprBox(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  let p = parseBranch(s, i, box, quoted, ctx);
  let branches: PatternAst[] | null = null;
  while (p !== null && s[p] === "|") {
    if (collectAst && branches === null) branches = [astOf(box)];
    const branch = new Box();
    p = parseBranch(s, p + 1, branch, quoted, ctx);
    if (collectAst && p !== null) branches!.push(astOf(branch));
    // Union does not distribute over the conjunct lists: materialize.
    const merged = box.materialize();
    merged.union(branch.materialize());
    box.and = [merged];
    box.ast = null;
  }
  if (collectAst && p !== null && branches !== null) {
    box.ast = keepIf({ t: "alt", parts: branches });
  }
  return p;
}

/**
 * Parse a pattern into its tree, for exact per-match verification.
 *
 * Same grammar, same functions, same construct builders as compilation — the
 * parse IS a compilation, with the structure kept alongside wherever a
 * predicate sits below it. No trailing space is appended: the verifier reads
 * the match as displayed, not as the index stores it.
 */
export function parsePatternAst(query: string, ctx: SessionContext): PatternAst {
  collectAst = true;
  try {
    const box = new Box();
    const p = parseExprBox(query, 0, box, false, ctx);
    if (p === null || p !== query.length) {
      throw new ParseError(p === null ? query : query.slice(p));
    }
    return astOf(box);
  } finally {
    collectAst = false;
  }
}

/** Back-compat wrapper: parse and materialize into an NFA. */
export function parseExpr(
  s: string,
  i: number,
  fst: Nfa,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  const box = new Box();
  const p = parseExprBox(s, i, box, quoted, ctx);
  if (p !== null) fst.copyFrom(box.materialize());
  return p;
}

function parseBranch(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  const first = new Box();
  let p = parseFactor(s, i, first, quoted, ctx);
  box.and = first.and;
  box.ast = first.ast;
  let parts: PatternAst[] | null = null;
  while (p !== null && s[p] === "&") {
    // Captured before the flatten below appends to the shared array.
    if (collectAst && parts === null) parts = [astOf(box)];
    const next = new Box();
    p = parseFactor(s, p + 1, next, quoted, ctx);
    if (collectAst && p !== null) parts!.push(astOf(next));
    // Intersection is associative: just flatten the conjunct lists.
    box.and.push(...next.and);
  }
  if (collectAst && p !== null && parts !== null) {
    box.ast = keepIf({ t: "and", parts });
  }
  return p;
}

function parseFactor(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  if (s[i] === "!") {
    // Negation applies to the whole factor, so `!.*ee.*` reads as "no double
    // e" rather than binding to the first piece.
    const inner = new Box();
    const p = parseFactor(s, i + 1, inner, quoted, ctx);
    if (p === null || p === i + 1) return null; // nothing to negate
    // Captured before materialize collapses the inner box.
    const innerAst = collectAst ? astOf(inner) : null;
    // Complement flips the direction of approximation: the hull of a
    // predicate-bearing subtree over-approximates it, so the complement of
    // that hull UNDER-approximates the complement and the search would drop
    // matches the verifier would keep. The only sound hull for a negated
    // predicate is "anything"; the exact complement is the verifier's job.
    const predInside = collectAst
      ? hasPred(innerAst!)
      : mentionsConstruct(s.slice(i + 1, p), PREDICATE_NAMES);
    if (predInside) {
      box.and = [anyString()];
      if (collectAst) box.ast = { t: "not", inner: innerAst! };
      return p;
    }
    // Left unmaterialized: `ComplementFilter` walks it lazily at search time,
    // and only `Box.materialize` — a union or a quantifier around the
    // negation, where an NFA is structurally required — has to pay for the
    // eager complement.
    box.and = [{ not: inner.materialize() }];
    return p;
  }
  box.and = [epsilonNfa()];
  box.ast = null;
  let isEpsilon = true; // box is still the empty-string identity
  const parts: PatternAst[] = [];
  let p = i;
  for (;;) {
    const piece = new Box();
    const n = parsePiece(s, p, piece, quoted, ctx);
    if (n === null) {
      if (collectAst && parts.length > 1) {
        box.ast = keepIf({ t: "seq", parts });
      }
      return p;
    }
    if (collectAst) parts.push(astOf(piece));
    if (isEpsilon) {
      // ε · X = X: adopt the piece wholesale, conjunct structure intact.
      box.and = piece.and;
      box.ast = piece.ast;
      isEpsilon = false;
    } else {
      // General concatenation does not distribute over intersections:
      // materialize both sides. (The one sound distribution — a fixed-length
      // suffix — is applied by compileQuery for the trailing space.)
      const merged = box.materialize();
      merged.concat(piece.materialize());
      box.and = [merged];
      box.ast = null;
    }
    p = n;
  }
}

function parsePiece(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  const atom = new Box();
  let p = parseAtom(s, i, atom, quoted, ctx);
  if (p === null) return null;

  let min: number;
  let max: number;
  const INF = Number.MAX_SAFE_INTEGER;
  if (s[p] === "*") {
    min = 0;
    max = INF;
    ++p;
  } else if (s[p] === "+") {
    min = 1;
    max = INF;
    ++p;
  } else if (s[p] === "?") {
    min = 0;
    max = 1;
    ++p;
  } else if (s[p] === "{" && /^\{\d*(,\d*)?\}/.test(s.slice(p))) {
    // Only a `{m,n}` shape is a quantifier. Anything else starting with `{`
    // is a named construct and belongs to the *next* piece, so `A* {rhyme:day}`
    // and `x{sum=1:A*}` read the way they look.
    const m = /^(\d*)(?:(,)(\d*))?/.exec(s.slice(p + 1))!;
    min = m[1] === "" ? 0 : parseInt(m[1], 10);
    if (m[2] === ",") {
      max = m[3] === "" ? INF : parseInt(m[3], 10);
    } else {
      max = min;
    }
    p += 1 + m[0].length;
    // Cap min like max: an unbounded lower bound (a{100000,}) would loop
    // building a huge NFA with no cancellation path.
    if (s[p] !== "}" || max < min || (max > 255 && max < INF) || min > 255) {
      return null;
    }
    ++p;
  } else {
    // No quantifier: the atom passes through with conjuncts intact.
    box.and = atom.and;
    box.ast = atom.ast;
    return p;
  }

  // Captured before materialize collapses the atom.
  const atomAst = collectAst ? astOf(atom) : null;

  // Quantifiers don't distribute over intersections: materialize the atom.
  const one = atom.materialize();

  // fst = union of one^i for min <= i <= max; `many` accumulates one^i.
  const fst = new Nfa();
  const many = epsilonNfa();

  for (let n = 0; n <= min || (n <= max && max < INF); ++n) {
    if (n >= min) fst.union(many);
    many.concat(one);
  }

  if (max >= INF) {
    const star = one.clone();
    star.closureStar();
    many.concat(star);
    fst.union(many);
  }

  box.and = [fst];
  if (collectAst) {
    box.ast = keepIf({
      t: "rep",
      inner: atomAst!,
      min,
      max: max >= INF ? Infinity : max,
    });
  }
  return p;
}

function parseAtom(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  if (i >= s.length) return null;

  if (s[i] === '"' && !quoted) {
    const p = parseExprBox(s, i + 1, box, true, ctx);
    if (p === null || s[p] !== '"') return null;
    return p + 1;
  } else if (s[i] === "(") {
    const p = parseExprBox(s, i + 1, box, quoted, ctx);
    if (p === null || s[p] !== ")") return null;
    return p + 1;
  } else if (s[i] === "<" && s[i + 1] === "<") {
    // <<letters>> is the puzzle notation for a letter bank.
    const close = s.indexOf(">>", i + 2);
    if (close < 0) return null;
    const bank = bankConstraint(s.slice(i + 2, close), "bank");
    if (!bank) return null;
    box.and = bank;
    return close + 2;
  } else if (s[i] === "<") {
    const p = parseAnagram(s, i + 1, box, quoted, ctx);
    if (p === null || s[p] !== ">") return null;
    return p + 1;
  } else if (s[i] === "{" && s[i + 1] === "=") {
    // `{=name:…}`: a capture. Matches whatever its pattern matches; the span
    // it covers is remembered under the name, for a relation ({eq…}, {rev…},
    // {shift…}) wrapping it to consult. Transparent to the search.
    const head = /^\{=([a-z][a-z0-9]*):/.exec(s.slice(i));
    if (!head) {
      throw new ParseError(
        constructText(s, i),
        "{=name:…} names the span a pattern covers — a short lower-case " +
          "name, then the pattern: {=a:A{3}}",
      );
    }
    const innerBox = new Box();
    const p = parseExprBox(s, i + head[0].length, innerBox, quoted, ctx);
    if (p === null || s[p] !== "}") return null;
    box.and = innerBox.and;
    if (collectAst) {
      box.ast = { t: "cap", name: head[1], inner: astOf(innerBox) };
    }
    return p + 1;
  } else if (s[i] === "{") {
    // A brace at atom position is a named constraint; as a quantifier it can
    // only follow an atom, so there is no ambiguity with `A{4,8}`.
    return parseNamedConstraint(s, i, box, quoted, ctx);
  }

  const chars: number[] = [];
  let negate = false;
  let p = i;

  if (s[p] === "[") {
    if (s[++p] === "^") {
      negate = true;
      ++p;
    }
    while (s[p] !== "]") {
      if (p >= s.length) return null;
      if (s[p] === "-") {
        const first = s.charCodeAt(p - 1);
        const last = s.charCodeAt(p + 1);
        for (let c = first + 1; c <= last; ++c) {
          const isOk =
            (c >= 0x61 && c <= 0x7a) ||
            (c >= 0x30 && c <= 0x39) ||
            c === CODE_SPACE;
          if (!isOk) return null;
          chars.push(c);
        }
        p += 2;
      } else {
        const n = parseCharClass(s, p, chars);
        if (n === null) return null;
        p = n;
      }
    }
    ++p;
  } else {
    const n = parseCharClass(s, p, chars);
    if (n === null) return null;
    p = n;
  }

  const fst = new Nfa();
  const start = fst.addState();
  const final = fst.addState();
  fst.setStart(start);
  fst.setFinal(final);
  if (negate) {
    const all: number[] = [];
    parseCharClass(".", 0, all);
    for (const c of all) {
      if (!chars.includes(c)) fst.addArc(start, c, final);
    }
  } else {
    for (const c of chars) fst.addArc(start, c, final);
  }

  if (!quoted) {
    fst.addArc(start, CODE_SPACE, start);
    fst.addArc(final, CODE_SPACE, final);
  }

  box.and = [fst];
  return p;
}

/**
 * A construct spelled correctly but given no argument: `{rot13}`, `{caesar}`,
 * `{sum=52}`.
 *
 * Dispatch needs the colon, so these never reached the construct that would
 * have explained itself, and came back as `can't parse "{rot13}"` — the one
 * message that cannot help, because it suggests the name is wrong when the
 * name is the only part that was right. Every construct already carries a
 * summary and a worked example for the generated reference, so the answer is
 * to say those.
 *
 * Throws when it recognises the name and returns otherwise, leaving `{5}` and
 * every other brace-shaped thing to be parsed as whatever it is.
 */
function bareConstruct(s: string, i: number): void {
  const bare = /^\{\s*([a-z][a-z.]*)\s*([^:}]*)\}/i.exec(s.slice(i));
  if (!bare) return;
  const token = bare[1].toLowerCase();
  const typed = token.slice(token.lastIndexOf(".") + 1);
  const { name } = foldName(typed, bare[2]);
  const info = findConstruct(name);
  if (!info) {
    // Not a construct, but close to one: `{palindrom}` is a typo, and saying
    // "can't parse" sends the reader looking at their braces. The colonned
    // form already suggests a near name; this makes the two agree.
    const near = suggestConstruct(name);
    if (near) {
      const suggested = findConstruct(near);
      throw new ParseError(
        constructText(s, i),
        `no such constraint "${name}" — did you mean "${near}"? ` +
          `Try ${suggested?.example ?? `{${near}:…}`}`,
      );
    }
    return;
  }
  // Named as it was typed, not as it folds: someone who wrote `{rot13}` is
  // not helped by a message about `{rot…}`, which is a name they have never
  // seen. `bare[2]` carries the digits back, since the name lexes as letters.
  const shown = `${typed}${bare[2].trim()}`;
  throw new ParseError(
    constructText(s, i),
    `{${shown}…} takes an argument after a colon — ${info.summary}. ` +
      `Try ${info.example}`,
  );
}

/** The `{…}` construct starting at `i`, for error messages. */
function constructText(s: string, i: number): string {
  const close = s.indexOf("}", i);
  return close < 0 ? s.slice(i) : s.slice(i, close + 1);
}

/** Index just past the `}` matching the `{` at `open`, or -1. */
function matchingClose(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; ++j) {
    if (s[j] === "{") ++depth;
    else if (s[j] === "}" && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * A predicate construct at any position in the pattern: `{palindrome:A{5}}`
 * beside a neighbour, under a quantifier, inside an anagram part.
 *
 * The search cannot ask a predicate's question — that is what makes it a
 * predicate — so what compiles here is the argument alone: the predicate's
 * *hull*. What keeps that honest is the `where` result filter, which parses
 * each finished match against the whole pattern and asks every predicate of
 * exactly the span its node covers (span-verify.ts). A predicate wrapping the
 * whole query never reaches this code: parseFilterWrappers peels it first, as
 * it always has, and checks it without a reparse.
 *
 * Returns undefined when the brace is not a predicate construct at all, so
 * the ordinary construct path can read it.
 */
function parseNestedPredicate(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null | undefined {
  const head = /^\{\s*([a-z][a-z.]*)\s*/i.exec(s.slice(i));
  if (!head) return undefined;
  const token = head[1].toLowerCase();
  const bare = token.slice(token.lastIndexOf(".") + 1);
  if (!PREDICATE_NAMES.includes(bare)) return undefined;
  if (token.includes(".")) {
    const resolved = resolveConstruct(token, "");
    if (resolved && "error" in resolved) {
      throw new ParseError(constructText(s, i), resolved.error);
    }
  }
  // The colon that ends the spec is the one at brace depth zero: the spec may
  // hold a whole pattern of its own, as in `{anagram {kind:bird}:A{6}}`.
  let depth = 0;
  let colon = -1;
  for (let j = i + head[0].length; j < s.length; ++j) {
    const c = s[j];
    if (c === "{") ++depth;
    else if (c === "}") {
      if (depth === 0) break;
      --depth;
    } else if (c === ":" && depth === 0) {
      colon = j;
      break;
    }
  }
  if (colon === -1) {
    // `{palindrome}` with nothing to hold of: the bare-construct message.
    bareConstruct(s, i);
    return null;
  }
  const specText = s.slice(i + head[0].length, colon).trim();
  // `{iso:…}`: the only predicate whose argument is data rather than a
  // pattern. What follows the colon is ciphertext; the search pattern — the
  // hull — is synthesized from it (shape, word breaks, the most-repeated
  // letters pinned), and the verifier checks full isomorphism per match.
  if (bare === "iso") {
    const close = matchingClose(s, i);
    if (close < 0) return null;
    const text = constructText(s, i);
    if (specText !== "") {
      throw new ParseError(
        text,
        "{iso:…} takes just the ciphertext — e.g. {iso:xjxj yjkw}",
      );
    }
    const cipher = normalizeCipher(s.slice(colon + 1, close - 1));
    if (cipher === null) {
      throw new ParseError(
        text,
        "{iso:…} takes ciphertext of letters and spaces — e.g. {iso:xjxj}",
      );
    }
    const hull = isoHull(cipher);
    box.and = [hull];
    if (collectAst) {
      box.ast = {
        t: "pred",
        spec: { kind: "iso", cipher },
        inner: { t: "nfa", and: [cloneConjunct(hull)] },
      };
    }
    return close;
  }
  // A relation names two captures inside the pattern it wraps. Parsed apart
  // from the FilterSpec predicates: its verdict needs the parse, not just the
  // match text, so it becomes its own AST node.
  let rel: { op: "eq" | "rev" | "shift"; shift: number | null;
             names: [string, string] } | null = null;
  if (isRelationName(bare)) {
    const m = /^(\d+)?\s*([a-z][a-z0-9]*)\s*,\s*([a-z][a-z0-9]*)$/.exec(specText);
    if (!m || (bare !== "shift" && m[1] !== undefined)) {
      throw new ParseError(
        constructText(s, i),
        `{${bare} …} takes two capture names — {${bare}${
          bare === "shift" ? "13" : ""
        } a,b:{=a:A{3}} {=b:A{3}}}`,
      );
    }
    const shift = m[1] === undefined ? null : parseInt(m[1], 10);
    if (shift !== null && (shift < 1 || shift > 25)) {
      throw new ParseError(constructText(s, i), "a shift is 1 to 25");
    }
    rel = { op: bare as "eq" | "rev" | "shift", shift, names: [m[2], m[3]] };
    // Both names must be bound somewhere inside — an unbound name would make
    // the relation quietly false for every match.
    const wrapped = s.slice(colon + 1, matchingClose(s, i));
    for (const name of rel.names) {
      if (!wrapped.includes(`{=${name}:`)) {
        throw new ParseError(
          constructText(s, i),
          `{${bare} …} names "${name}", but nothing inside is captured as ` +
            `{=${name}:…}`,
        );
      }
    }
  }
  let spec = null;
  if (rel === null) {
    try {
      spec = parseFilterSpec(bare, specText);
    } catch (e) {
      if (e instanceof FilterError) {
        throw new ParseError(constructText(s, i), e.message);
      }
      throw e;
    }
  }
  const innerBox = new Box();
  const p = parseExprBox(s, colon + 1, innerBox, quoted, ctx);
  if (p === null || s[p] !== "}") return null;
  if (p === colon + 1) {
    throw new ParseError(constructText(s, i), `{${bare} …} needs a pattern`);
  }
  box.and = innerBox.and;
  if (collectAst) {
    box.ast = rel
      ? { t: "rel", ...rel, inner: astOf(innerBox) }
      : { t: "pred", spec: spec!, inner: astOf(innerBox) };
  }
  return p + 1;
}

/**
 * `{name spec:PATTERN}` — the pattern, intersected with a constraint automaton
 * named by `name`. Returns null (a parse error) for an unknown name, so the
 * user gets the standard "can't parse" pointer at the offending text.
 */
function parseNamedConstraint(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  // `{~name:…}` — a soft construct: boost instead of filter.
  const soft = /^\{\s*~\s*([a-z]+)\s*([^:}]*):/i.exec(s.slice(i));
  if (soft) {
    const close = s.indexOf("}", i);
    if (close < 0) return null;
    const folded = foldName(soft[1].toLowerCase(), soft[2]);
    box.and = [
      softConjunct(
        folded.name,
        folded.spec,
        s.slice(i + soft[0].length, close),
        ctx,
        constructText(s, i),
      ),
    ];
    return close + 1;
  }
  const nested = parseNestedPredicate(s, i, box, quoted, ctx);
  if (nested !== undefined) return nested;
  const head = /^\{\s*([a-z][a-z.]*)\s*([^:}]*):/i.exec(s.slice(i));
  if (!head) {
    bareConstruct(s, i);
    return null;
  }
  // Names lex as letters, so trailing digits land in the spec — that is what
  // makes {del1:…} and {rot13:…} work. Two names are genuinely digit-bearing;
  // fold them back before dispatching.
  const token = head[1].toLowerCase();
  let spec = head[2];
  // An optional group prefix: {cipher.rot13:…} says which family this is, and
  // is rejected if it names the wrong one. The bare form stays valid — every
  // shared query URL uses it.
  if (token.includes(".")) {
    const resolved = resolveConstruct(token, spec);
    if (resolved && "error" in resolved) {
      throw new ParseError(constructText(s, i), resolved.error);
    }
  }
  const folded = foldName(token.slice(token.lastIndexOf(".") + 1), spec);
  const name = folded.name;
  spec = folded.spec;
  const construct = CONSTRUCT_BUILDERS[name];
  // A construct pack's name, folded like the built-ins — digits lex
  // into the spec, so a pack's {row9:…} arrives as "row" + "9". Checked
  // before the built-in table because a pack cannot shadow a built-in name
  // (parsePack refuses), so a hit here is unambiguous even when the bare
  // letters collide with one ("row9" beside the built-in row1..row3).
  {
    const packed =
      /^\d+$/.test(spec.trim()) && ctx.packs.has(name + spec.trim())
        ? { c: ctx.packs.get(name + spec.trim())!, spec: "" }
        : ctx.packs.has(name)
          ? { c: ctx.packs.get(name)!, spec }
          : null;
    if (packed) {
      const text = constructText(s, i);
      if (packed.c.type === "substitution") {
        const close = s.indexOf("}", i);
        if (close < 0) return null;
        const built = packConjuncts(
          packed.c,
          packed.spec,
          s.slice(i + head[0].length, close),
        );
        if (!built) throw new ParseError(text, packAdvice(packed.c));
        box.and = built;
        return close + 1;
      }
      const built = packConjuncts(packed.c, packed.spec, "");
      if (!built) throw new ParseError(text, packAdvice(packed.c));
      const p = parseExprBox(s, i + head[0].length, box, quoted, ctx);
      if (p === null || s[p] !== "}") return null;
      const wrappedAst = collectAst ? astOf(box) : null;
      box.and.push(...built);
      if (collectAst) {
        box.ast = keepIf({
          t: "and",
          parts: [wrappedAst!, { t: "nfa", and: built.map(cloneConjunct) }],
        });
      }
      return p + 1;
    }
  }
  let conjuncts: Nfa[] | null = null;
  // Where the construct ends: past its closing brace. The three argument
  // kinds differ only in how much of the text belongs to the construct and
  // how it is read — see construct-table.ts.
  let after: number | null = null;
  if (construct) {
    const text = constructText(s, i);
    const from = i + head[0].length;
    if (construct.argKind === "literal") {
      const close = s.indexOf("}", i);
      if (close < 0) return null;
      conjuncts = construct.build({
        name, spec, arg: s.slice(from, close), inner: null, ctx, text,
      });
      after = close + 1;
    } else if (construct.argKind === "inner") {
      // A box of its own, parsed quoted: the argument is what the construct
      // is *about*, not something to intersect the pattern with.
      //
      // No predicates in here: the match is the *edited* string, and the
      // string it was edited from — the one the predicate would be asked of —
      // is not part of the match. Everywhere else a predicate's span is a
      // piece of the match; here it would be a piece of something the match
      // merely resembles.
      const argEnd = matchingClose(s, i);
      if (
        argEnd > 0 &&
        mentionsConstruct(s.slice(from, argEnd), PREDICATE_NAMES)
      ) {
        throw new ParseError(
          text,
          `a predicate can't sit inside {${name}…}: the match is the edited ` +
            `string, and the original it was edited from is not there to ` +
            `check. Put the predicate outside — {palindrome:{${name}…:…}} ` +
            `asks it of the match itself.`,
        );
      }
      const argBox = new Box();
      const p = parseExprBox(s, from, argBox, true, ctx);
      if (p === null || s[p] !== "}") return null;
      conjuncts = construct.build({
        name, spec, arg: "", inner: argBox.materialize(), ctx, text,
      });
      after = p + 1;
    } else {
      conjuncts = construct.build({
        name, spec, arg: "", inner: null, ctx, text,
      });
      // "wrap": the argument is a pattern this intersects with, so it is
      // parsed into the caller's box and the conjuncts join it below.
    }
    if (conjuncts && after !== null) {
      box.and = conjuncts;
      return after;
    }
  }
  if (!conjuncts) {
    const whole = s.slice(i, s.indexOf("}", i) + 1 || undefined);
    const known = findConstruct(name);
    if (!known) {
      const near = suggestConstruct(name);
      throw new ParseError(
        whole,
        `no such constraint "${name}"${near ? ` — did you mean "${near}"?` : ""}`,
      );
    }
    if (known.level !== "automaton") {
      // It exists — it just cannot be nested. Saying "no such constraint" here
      // sent people looking for a typo in a name that was spelled correctly.
      throw new ParseError(whole, levelAdvice(known));
    }
    const big = /(\d{4,})/.exec(spec);
    throw new ParseError(
      whole,
      big && +big[1] >= MAX_COUNTER_STATES
        ? `${name} bound ${big[1]} is too large (max ${MAX_COUNTER_STATES - 1})`
        : `"${name}" doesn't understand "${spec.trim()}" in ${whole}`,
    );
  }
  const p = parseExprBox(s, i + head[0].length, box, quoted, ctx);
  if (p === null || s[p] !== "}") return null;
  // Captured before the construct's conjuncts join the same array: the AST
  // keeps the wrapped pattern and the constraint as separate sides of an
  // intersection, so a predicate inside the wrapped pattern keeps its span.
  const wrappedAst = collectAst ? astOf(box) : null;
  box.and.push(...conjuncts);
  if (collectAst) {
    box.ast = keepIf({
      t: "and",
      parts: [wrappedAst!, { t: "nfa", and: conjuncts.map(cloneConjunct) }],
    });
  }
  return p + 1;
}

function parseCharClass(s: string, i: number, out: number[]): number | null {
  if (i >= s.length) return null;
  const ch = s[i];
  const c = s.charCodeAt(i);
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || ch === " ") {
    out.push(c);
  } else if (ch === "-") {
    // Optional space: epsilon (label 0) or a space.
    out.push(EPSILON);
    out.push(CODE_SPACE);
  } else if (ch === ".") {
    for (let d = 0x30; d <= 0x39; ++d) out.push(d);
    for (let a = 0x61; a <= 0x7a; ++a) out.push(a);
    out.push(CODE_SPACE);
  } else if (ch === "_") {
    for (let d = 0x30; d <= 0x39; ++d) out.push(d);
    for (let a = 0x61; a <= 0x7a; ++a) out.push(a);
  } else if (ch === "#") {
    for (let d = 0x30; d <= 0x39; ++d) out.push(d);
  } else if (ch === "A") {
    for (let a = 0x61; a <= 0x7a; ++a) out.push(a);
  } else if (ch === "C") {
    for (let a = 0x61; a <= 0x7a; ++a) {
      if (!"aeiou".includes(String.fromCharCode(a))) out.push(a);
    }
  } else if (ch === "V") {
    for (let a = 0x61; a <= 0x7a; ++a) {
      if ("aeiou".includes(String.fromCharCode(a))) out.push(a);
    }
  } else {
    return null;
  }
  return i + 1;
}

// ---- Anagrams (port of expr-anagram.cpp) ----

interface AnagramPart {
  expr: Nfa;
  count: number;
  /** The part's tree, when collectAst is on; null otherwise. */
  ast: PatternAst | null;
}

function collapseIdentical(parts: AnagramPart[]): void {
  // A part carrying a predicate is never merged: `equivalent` compares hulls,
  // and two parts with the same hull can ask different questions —
  // <{palindrome:A{4}}{reversible:A{4}}> is two constraints, not one twice.
  const mergeable = (p: AnagramPart) => p.ast === null || !hasPred(p.ast);
  for (let i = 0; i < parts.length; ++i) {
    let jout = i + 1;
    for (let jin = i + 1; jin < parts.length; ++jin) {
      if (
        mergeable(parts[i]) &&
        mergeable(parts[jin]) &&
        equivalent(parts[i].expr, parts[jin].expr)
      ) {
        ++parts[i].count;
      } else {
        parts[jout++] = parts[jin];
      }
    }
    parts.length = jout;
  }
}

/** The anagram as a conjunct list (Nutrimatic materializes; we defer). */
function makeAnagramConjuncts(parts: AnagramPart[]): Nfa[] {
  const conjuncts: Nfa[] = [];

  // any = union of all parts; total = number of pieces.
  const any = new Nfa();
  let total = 0;
  for (const part of parts) {
    any.union(part.expr);
    total += part.count;
  }

  // The match consists of exactly `total` pieces...
  const hasLength = epsilonNfa();
  for (let i = 0; i < total; ++i) hasLength.concat(any);
  conjuncts.push(hasLength);

  // ...and for each part, contains it `count` times (with any others around).
  for (let i = 0; i < parts.length; ++i) {
    const others = new Nfa();
    for (let j = 0; j < parts.length; ++j) {
      if (j !== i) others.union(parts[j].expr);
    }
    others.closureStar();

    const containsPart = others.clone();
    for (let n = 0; n < parts[i].count; ++n) {
      containsPart.concat(parts[i].expr);
      containsPart.concat(others);
    }
    conjuncts.push(containsPart);
  }

  return conjuncts;
}

function parseAnagram(
  s: string,
  i: number,
  box: Box,
  quoted: boolean,
  ctx: SessionContext,
): number | null {
  const parts: AnagramPart[] = [];
  let p = i;
  while (s[p] !== ">") {
    if (p >= s.length) return null;
    const piece = new Box();
    const n = parsePiece(s, p, piece, quoted, ctx);
    if (n === null) return null;
    p = n;
    // Captured before materialize collapses the piece.
    const ast = collectAst ? astOf(piece) : null;
    parts.push({ expr: optimize(piece.materialize()), count: 1, ast });
  }

  // An anagram of one thing is that thing, which is never what someone meant
  // by writing it. `<{del1:{list:countries}}>` returned exactly what
  // `{del1:{list:countries}}` returns, with nothing to say the angle brackets
  // had done nothing — the reader is left thinking the anagram was applied.
  // `<…>` permutes the parts *written between the brackets*, so `<aaagmnr>` is
  // seven of them.
  //
  // The message names `{anagram …:…}`, which is the thing the reader wanted:
  // it rearranges whatever a pattern matches, which is exactly what the angle
  // brackets cannot do. This said "there is no way" until that construct
  // existed, and a message that tells someone their goal is impossible had
  // better stop saying it the moment it is not.
  if (parts.length < 2) {
    throw new ParseError(
      s.slice(i - 1, p + 1),
      "an anagram needs at least two parts to rearrange — <…> permutes what " +
        "you write between the brackets, so <aaagmnr> is seven letters, and " +
        "<one-thing> is just that thing. To rearrange whatever a pattern " +
        "matches, use {anagram …:…} — e.g. {anagram {kind:bird}:A{6}} or " +
        "{anagram countries:A{5}}.",
    );
  }
  collapseIdentical(parts);
  box.and = makeAnagramConjuncts(parts);
  if (collectAst) {
    box.ast = keepIf({
      t: "anagram",
      parts: parts.map((part) => ({ ast: part.ast!, count: part.count })),
    });
  }
  return p;
}
