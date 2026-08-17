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
// This is also the shape the roadmap's predicate list (C1) needs: one
// (text -> keep + note) decision that can be stacked, rather than a single
// filter slot hardcoded into two pipelines.

import { SessionContext } from "./session-context.js";
import { listKey, wordList } from "./word-lists.js";
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
      const entry = anagramOf(filter.list, text, ctx);
      return entry === null ? DROP : { keep: true, note: `← ${entry}` };
    }
  }
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
function anagramOf(
  list: string,
  text: string,
  ctx: SessionContext,
): string | null {
  const mine = letters(text);
  const key = mine.split("").sort().join("");
  const entries = anagramKeys(list, ctx)?.get(key);
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
function anagramKeys(
  list: string,
  ctx: SessionContext,
): Map<string, string[]> | null {
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
  // Bundled lists first, then the harvested catalogue — the same order
  // `{list:…}` resolves in, so the two agree about what a list contains.
  const entries =
    wordList(name) ?? ctx.lists?.entries.get(name) ?? null;
  let built: Map<string, string[]> | null = null;
  if (entries !== null) {
    built = new Map();
    for (const e of entries) {
      const k = letters(e).split("").sort().join("");
      const at = built.get(k);
      if (at) at.push(e);
      else built.set(k, [e]);
    }
  }
  perCtx.set(name, built);
  return built;
}

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
