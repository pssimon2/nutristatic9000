// "Is this string a word the index knows?" — the predicate behind
// {compound …} and {reversible …}.
//
// Walk it from the root and require the following space: the space is what
// proves a word boundary rather than a prefix, so CAR matches only if the
// corpus really contains CAR and not just CARTOON. Answers are memoised, so a
// candidate set costs one walk per distinct piece rather than one per result.
//
// Presence alone is not enough, though, and that made both constructs return
// visible nonsense. The index is a corpus, not a dictionary: web text contains
// every typo and every word broken across a line, so `{reversible:A{4}}`
// answered "that", because "taht" is in there, and `{compound 2:A{9}}` cut
// AVAILABLE into "avai" and "lable". Both are in the corpus. Neither is a
// word.
//
// What separates them is not presence but *weight*. A real word carries a
// share of the corpus; debris carries a rounding error. Measured on the demo
// index, as a fraction of all occurrences:
//
//   genuine compound pieces   copy 1.4e-4  right 4.7e-4  thing 1.7e-4
//   debris accepted as words  avai 9.1e-8  lable 2.1e-7  erent 4.3e-7
//   genuine reversals         emit 2.1e-6  pots 6.6e-6   rats 1.5e-5
//   junk reversals            morf 6.0e-8  eht  2.5e-7   taht 3.3e-7
//
// So the floor is a *relative* frequency, which is also the only form of this
// that survives the index being German or Portuguese — an absolute count means
// nothing across corpora three orders of magnitude apart in size, and a word
// list would be English-only.
//
// The two constructs get different floors because they ask different
// questions. A compound's pieces are by nature ordinary words, so they must
// clear the higher bar that separates them from fragments. A reversal only has
// to be a word at all, and the rare end of that (emit, pots) sits an order of
// magnitude lower — low enough that this floor removes the junk without
// claiming to be a dictionary. It is a threshold, not a decision procedure:
// a rare enough real word still fails it, and a common enough typo still
// passes.

import type { IndexReader } from "./index-reader.js";
import { probeCount } from "./index-probe.js";
import type { WordCheck } from "./compound.js";

/**
 * Least share of the corpus a compound's piece must carry. Fragments measured
 * up to 3e-6; genuine pieces start around 1e-4, so this sits in the gap.
 */
export const COMPOUND_PIECE_FLOOR = 1e-5;

/**
 * Least share of the corpus a reversal must carry. An order of magnitude
 * below the compound floor, because a reversal need only be a word, and the
 * rare ones (emit, pots, desserts) live down here.
 */
export const REVERSAL_FLOOR = 1e-6;

/**
 * Shortest piece a compound may cut into. A single letter clears any
 * frequency floor — initials and list markers make "p", "s" and "y" common
 * standalone tokens — which is how PRESIDENT came back cut as "p·resident".
 * Two is the minimum that removes them without ruling out AN, OX or GO.
 */
export const MIN_COMPOUND_PIECE = 2;

/**
 * A word test backed by the index.
 *
 * The caller supplies `minShare` — the fraction of the corpus the word must
 * account for — because it is the construct that knows which question it is
 * asking. 0 is presence alone, which is what a caller wants when it means "is
 * this in the index" rather than "is this a word".
 */
export function makeWordChecker(reader: IndexReader): WordCheck {
  // Keyed by word rather than by word-and-floor: the count does not depend on
  // what is being asked of it, so one walk answers every floor.
  const counts = new Map<string, Promise<number>>();
  const total = reader.count();
  return async (word: string, minShare = 0): Promise<boolean> => {
    if (word.length === 0) return false;
    let count = counts.get(word);
    if (count === undefined) {
      count = probeCount(reader, word);
      counts.set(word, count);
    }
    return (await count) >= minShare * total;
  };
}
