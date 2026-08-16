// "Is this string a word the index knows?" — the predicate behind
// {compound …} and {reversible …}.
//
// Walk it from the root and require the following space: the space is what
// proves a word boundary rather than a prefix, so CAR matches only if the
// corpus really contains CAR and not just CARTOON. Answers are memoised, so a
// candidate set costs one walk per distinct piece rather than one per result.

import type { IndexReader } from "./index-reader.js";
import type { WordCheck } from "./compound.js";

export function makeWordChecker(reader: IndexReader): WordCheck {
  const cache = new Map<string, boolean>();
  return async (word: string): Promise<boolean> => {
    const hit = cache.get(word);
    if (hit !== undefined) return hit;
    let ok = word.length > 0;
    if (ok) {
      let node = reader.root();
      let count = reader.count();
      for (const ch of `${word} `) {
        const out: Array<{ ch: number; count: number; next: number }> = [];
        const r = reader.children(node, count, out);
        if (r instanceof Promise) await r;
        const child = out.find((c) => c.ch === ch.charCodeAt(0));
        if (!child) {
          ok = false;
          break;
        }
        node = child.next;
        count = child.count;
      }
    }
    cache.set(word, ok);
    return ok;
  };
}
