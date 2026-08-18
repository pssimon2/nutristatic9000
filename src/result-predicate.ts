// Deciding whether a finished match survives its result filter, and what to
// annotate it with.
//
// The CLI and the worker each carried their own copy of this five-branch
// chain, identical down to the secondary-stress fold and differing only in how
// the annotation is formatted — the CLI appends it to a line, the worker sends
// it as a `note` field. Two copies of a rule the user experiences as one is
// how the two front ends drift apart, so the rule lives here and each caller
// formats the verdict its own way.
//
// The shape is one (text -> keep + note) decision that stacks, rather than
// a single filter slot hardcoded into two pipelines.

import { SessionContext } from "./session-context.js";
import { listKey, resolveListKey, wordList } from "./word-lists.js";
import { FilterError } from "./result-filter.js";
import { compileConjuncts } from "./find-expr.js";
import { innerNfa } from "./conjunct.js";
import { enumerateLanguage } from "./finite-strategy.js";
import { makeFilter } from "./expr-filter.js";
import { parsePatternAst } from "./expr-parse.js";
import { mentionsConstruct, namesAtLevel } from "./constructs.js";
import type { PatternAst } from "./pattern-ast.js";
import { PredicateCheck, verifyMatch } from "./span-verify.js";
import {
  FilterSpec,
  isPalindrome,
  letters,
  reversed,
} from "./result-filter.js";
import { WordCheck, splitWords } from "./compound.js";
import {
  COMPOUND_PIECE_FLOOR,
  MIN_COMPOUND_PIECE,
  REVERSAL_FLOOR,
} from "./index-words.js";
import { shapeOf, syllablesOf } from "./stress.js";

/** Whether a match survives, and the annotation to show if it does. */
export interface FilterVerdict {
  keep: boolean;
  /** Unformatted: "3 syll", "0101", "comm·unity", "← trap". Null if none. */
  note: string | null;
}

const DROP: FilterVerdict = { keep: false, note: null };

/**
 * Apply one result filter to a finished match.
 *
 * `isWord` asks the index whether a string is an indexed word; it may fetch
 * bytes in range mode, which is why this is async and why the worker buffers
 * results rather than streaming them when a filter is active.
 */
export async function applyResultFilter(
  filter: FilterSpec,
  text: string,
  ctx: SessionContext,
  isWord: WordCheck,
): Promise<FilterVerdict> {
  switch (filter.kind) {
    case "compound": {
      // A compound's pieces are ordinary words, so they must carry an
      // ordinary word's share of the corpus — presence alone cut AVAILABLE
      // into "avai" and "lable", both of which are in there.
      const parts = await splitWords(text, filter.pieces, (w) =>
        w.length < MIN_COMPOUND_PIECE ? false : isWord(w, COMPOUND_PIECE_FLOOR),
      );
      // Show the cut, so a weak reading (FOLLOW·ING) is visible as one.
      return parts ? { keep: true, note: parts.join("·") } : DROP;
    }
    case "syllables": {
      const n = syllablesOf(ctx.stress, text);
      if (n === null || n < filter.lo || n > filter.hi) return DROP;
      return { keep: true, note: `${n} syll` };
    }
    case "stress": {
      const shape = shapeOf(ctx.stress, text);
      // A secondary stress reads as stressed for metrical purposes.
      if (!shape || shape.replace(/2/g, "1") !== filter.shape.replace(/2/g, "1")) {
        return DROP;
      }
      return { keep: true, note: shape };
    }
    case "palindrome":
      return isPalindrome(text) ? { keep: true, note: null } : DROP;
    case "reversible": {
      // Reversal without a reverse index: ask whether the mirror is a word.
      const back = reversed(text);
      // The reversal has to be a word, not merely something the corpus
      // contains: "taht" is in there, which is why this used to answer
      // "that".
      if (back === letters(text) || !(await isWord(back, REVERSAL_FLOOR))) {
        return DROP;
      }
      return { keep: true, note: `← ${back}` };
    }
    case "anagram": {
      const entry = await anagramOf(filter.list, text, ctx, checkWith(ctx, isWord));
      return entry === null ? DROP : { keep: true, note: `← ${entry}` };
    }
    case "where": {
      // The pattern carries predicates inside it. The search ran on their
      // hulls; here the match is parsed against the pattern exactly, each
      // predicate asked of the span its node covers.
      const verdict = await verifyMatch(
        whereAst(filter.pattern, ctx),
        text.trim(),
        checkWith(ctx, isWord),
      );
      if (!verdict.keep) return DROP;
      return {
        keep: true,
        note: verdict.notes.length === 0 ? null : verdict.notes.join("  "),
      };
    }
  }
}

/** One predicate on one span, for the verifier: this module, called back. */
function checkWith(ctx: SessionContext, isWord: WordCheck): PredicateCheck {
  return (spec, span) => applyResultFilter(spec, span, ctx, isWord);
}

const PREDICATE_NAMES = namesAtLevel("predicate");

/** Per-session parsed patterns for `where`, by pattern text. */
const WHERE_ASTS = new WeakMap<SessionContext, Map<string, PatternAst>>();

/**
 * The pattern's tree, parsed once per session and pattern.
 *
 * A parse failure here is unusual — the same pattern compiled before the
 * search began, with the same context — so it is reported like the anagram
 * argument's failures: once per candidate, as the reason, never cached.
 */
function whereAst(pattern: string, ctx: SessionContext): PatternAst {
  let perCtx = WHERE_ASTS.get(ctx);
  if (perCtx === undefined) {
    perCtx = new Map();
    WHERE_ASTS.set(ctx, perCtx);
  }
  const cached = perCtx.get(pattern);
  if (cached !== undefined) return cached;
  let ast: PatternAst;
  try {
    ast = parsePatternAst(pattern, ctx);
  } catch (e) {
    throw new FilterError(e instanceof Error ? e.message : String(e));
  }
  perCtx.set(pattern, ast);
  return ast;
}

/**
 * Which entry of `list` the match rearranges, or null if none does.
 *
 * `<…>` rearranges the parts written between the brackets, so it cannot
 * rearrange a *set* — there is no way to spell out "any country". Asked of a
 * finished match instead it is a lookup: sort the match's letters and see
 * whether any entry sorts the same.
 *
 * The keyed index is built once per list and kept on the context, because a
 * predicate runs per candidate and a query sifts thousands.
 */
async function anagramOf(
  list: string,
  text: string,
  ctx: SessionContext,
  check: PredicateCheck,
): Promise<string | null> {
  const mine = letters(text);
  const key = mine.split("").sort().join("");
  const entries = (await anagramKeys(list, ctx, check))?.get(key);
  if (entries === undefined) return null;
  // Not the entry itself: every list member trivially rearranges to itself, and
  // "canada ← canada" is not an answer. Same rule as `{reversible:…}`, which
  // excludes a palindrome for trivially reversing to itself.
  return entries.find((e) => letters(e) !== mine) ?? null;
}

/**
 * Sorted-letters -> the entries with those letters, for one named list. Null if
 * there is no such list.
 *
 * A list of entries rather than one, because two members can share a key —
 * and if one of them is the match itself, the other is the answer.
 */
async function anagramKeys(
  list: string,
  ctx: SessionContext,
  check: PredicateCheck,
): Promise<Map<string, string[]> | null> {
  const name = listKey(list);
  // Kept beside the context rather than on it: `DataKey` is `keyof
  // SessionContext`, so a field there would make this look like a seventh side
  // dataset to the provider registry.
  let perCtx = ANAGRAM_KEYS.get(ctx);
  if (perCtx === undefined) {
    perCtx = new Map();
    ANAGRAM_KEYS.set(ctx, perCtx);
  }
  const cached = perCtx.get(name);
  if (cached !== undefined) return cached;
  // A list name first — bundled, then harvested, the same order `{list:…}`
  // resolves in, so the two agree about what a list contains. Only for an
  // argument shaped like a name, though: `listKey` strips punctuation, so
  // `A*` keys as "a" and could pick up a list by accident.
  const named = wordListLike(list)
    ? (wordList(name) ?? ctx.lists?.entries.get(resolveListKey(name)) ?? null)
    : null;
  // Failing that the argument is a pattern, and its language is the set to
  // rearrange — which is what makes `{anagram {kind:bird}:A{6}}` work, and
  // `{anagram beast:A*}`, and anything else that can be listed out.
  const entries = named ?? (await enumeratedSet(list, ctx, check));
  if (entries === null) {
    // Deliberately not cached. Caching the failure made this say its piece once
    // and then drop every later candidate in silence, so a second run of the
    // same query in one session reported "no results" instead of the reason.
    // No "did you mean" for a bare word. A mistyped list name and a word are
    // the same thing written down — "countrie" is a perfectly good five-letter
    // string to rearrange — and guessing would hijack `{anagram cheese:…}`,
    // which is one letter from the `cheeses` list. The rule stays plain: a list
    // if it is one, otherwise the word. List names are discoverable where it
    // matters, in the completion menu after `{anagram `.
    throw new FilterError(
      `{anagram …} needs something it can list out: a list name, a word, or a ` +
        `pattern matching at most ` +
        `${ANAGRAM_SET_CAP.toLocaleString("en-US")} strings. "${list}" is not ` +
        `bounded enough — try {anagram countries:…}, {anagram beast:…} or ` +
        `{anagram {kind:bird}:…}`,
    );
  }
  const built = new Map<string, string[]>();
  for (const e of entries) {
    const k = letters(e).split("").sort().join("");
    const at = built.get(k);
    if (at) at.push(e);
    else built.set(k, [e]);
  }
  perCtx.set(name, built);
  return built;
}

/**
 * The strings a pattern matches, when there are few enough to hold.
 *
 * Returns null when the argument does not compile, or matches unboundedly many
 * strings, or more than the cap — for which the caller has no answer to give
 * and says so once rather than dropping every candidate in silence.
 */
/** A bare word looks like a list name; anything else was meant as a pattern. */
function wordListLike(spec: string): boolean {
  return /^[a-z0-9 ]+$/i.test(spec.trim());
}

async function enumeratedSet(
  pattern: string,
  ctx: SessionContext,
  check: PredicateCheck,
): Promise<string[] | null> {
  // Quoted first, because the argument is a set of *words* to rearrange. An
  // unquoted atom carries an optional-space self-loop — that is what lets
  // `solar s_stem` match "solar system" — so the language of a bare `cargo` is
  // "cargo", "c argo", "c  argo" and on forever, and `{anagram cargo:A*}` was
  // refused for being unbounded. Quoting makes it the five letters it looks
  // like. Falls back to the query as written, in case quoting is what fails.
  const quoted = `"${pattern}"`;
  let asWritten = false;
  let conjuncts = compiled(quoted, ctx);
  if (conjuncts === null) {
    conjuncts = compiled(pattern, ctx);
    asWritten = true;
  }
  if (conjuncts === null) return null;
  // An intersection is listed out by listing its smallest finite part and
  // keeping what the rest accept. Requiring a single conjunct refused
  // `{anagram {list:greek}&A{5}:…}`, whose language is twenty-four Greek letters
  // narrowed to five characters, for being written as two conjuncts rather than
  // for being large.
  //
  // Not `finiteCandidates`, which looks like the same thing and is not: it
  // refuses a candidate set containing spaces, because the *search* strategy
  // cannot price a phrase that the walk would assemble from several index
  // entries. Here only the letters matter, and refusing phrases would drop
  // `{kind:bird}`, 68% of which are phrases.
  let best: { at: number; strings: string[] } | null = null;
  for (let i = 0; i < conjuncts.length; ++i) {
    const strings = enumerateLanguage(innerNfa(conjuncts[i]), ANAGRAM_SET_CAP);
    if (strings === null) continue; // cyclic, or past the cap
    if (best === null || strings.length < best.strings.length) {
      best = { at: i, strings };
    }
  }
  if (best === null) return null;
  // Compiled conjuncts carry the boundary space the search requires; the
  // entries are compared without it.
  const trimmed = best.strings.map((t) => t.replace(/ $/, ""));
  const rest = conjuncts.filter((_, i) => i !== best!.at);
  let survivors = trimmed;
  if (rest.length > 0) {
    const filter = makeFilter(rest);
    survivors = trimmed.filter((t) => accepts(filter, `${t} `));
  }
  // An argument may itself carry predicates — `{anagram {palindrome:A{4}}:…}`
  // rearranges four-letter palindromes. What was enumerated above is the
  // argument's hull; each entry is verified against the argument exactly, the
  // same way a match is verified against a pattern.
  if (mentionsConstruct(pattern, PREDICATE_NAMES)) {
    const ast = whereAst(asWritten ? pattern : quoted, ctx);
    const kept: string[] = [];
    for (const t of survivors) {
      if ((await verifyMatch(ast, t, check)).keep) kept.push(t);
    }
    survivors = kept;
  }
  return survivors;
}

/** Does the filter accept this exact string? */
function accepts(filter: ReturnType<typeof makeFilter>, text: string): boolean {
  let state = filter.startState;
  for (let i = 0; i < text.length; ++i) {
    state = filter.transition(state, text.charCodeAt(i));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

/** Compile, or null if it does not parse. */
function compiled(pattern: string, ctx: SessionContext) {
  try {
    return compileConjuncts(pattern, ctx);
  } catch {
    return null;
  }
}

/**
 * Most strings an `{anagram …}` argument may name. Generous, since the work is
 * one pass to build a keyed index and then a probe per candidate — but bounded,
 * because the argument may be `A*`.
 */
const ANAGRAM_SET_CAP = 20000;

/** Per-session anagram indexes, by list name. See anagramKeys. */
const ANAGRAM_KEYS = new WeakMap<
  SessionContext,
  Map<string, Map<string, string[]> | null>
>();

/**
 * Sort key for `{near:…}` ordering: the position of the match's closest word
 * in the neighbour list. A phrase ranks by its nearest word, and anything the
 * list doesn't mention sorts after everything it does.
 */
export function nearOrderKey(
  nearOrder: Map<string, number>,
  text: string,
): number {
  let best = Infinity;
  for (const word of text.split(" ")) {
    const i = nearOrder.get(word);
    if (i !== undefined && i < best) best = i;
  }
  return best;
}

/** Every filter's verdict on one match, ANDed, with the notes collected. */
export interface FiltersVerdict {
  keep: boolean;
  /** In the order the filters were written, outermost first. */
  notes: string[];
}

/**
 * Apply a stack of result filters. Short-circuits: the filters differ wildly
 * in cost — `{compound}` probes the index and may fetch bytes, `{palindrome}`
 * is a string comparison — so a cheap rejection should not pay for an
 * expensive one. Callers order them as the user wrote them.
 */
export async function applyResultFilters(
  filters: FilterSpec[],
  text: string,
  ctx: SessionContext,
  isWord: (word: string) => boolean | Promise<boolean>,
): Promise<FiltersVerdict> {
  const notes: string[] = [];
  for (const filter of filters) {
    const verdict = await applyResultFilter(filter, text, ctx, isWord);
    if (!verdict.keep) return { keep: false, notes: [] };
    if (verdict.note !== null) notes.push(verdict.note);
  }
  return { keep: true, notes };
}
