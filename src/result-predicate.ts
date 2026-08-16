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
import {
  FilterSpec,
  isPalindrome,
  letters,
  reversed,
} from "./result-filter.js";
import { splitWords } from "./compound.js";
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
  isWord: (word: string) => boolean | Promise<boolean>,
): Promise<FilterVerdict> {
  switch (filter.kind) {
    case "compound": {
      const parts = await splitWords(text, filter.pieces, isWord);
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
      if (back === letters(text) || !(await isWord(back))) return DROP;
      return { keep: true, note: `← ${back}` };
    }
  }
}

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
