// Ask the index about one string, without searching for it.
//
// A search walks the trie best-first over the whole alphabet, which is the
// right thing when the question is "what matches this pattern" and enormously
// too much when it is "how common is CHICKEN". That second question has a
// single path through the trie: one child lookup per character, and the count
// stored at the end is the answer.
//
// It is the cheap oracle a planner needs — how selective is this literal, is
// this phrase in the corpus at all — and it is also, already, the question
// behind `{compound …}` and `{reversible …}`, which had their own copy of this
// walk before this module existed.
//
// Range-aware by construction: `reader.children` returns a promise when the
// bytes are not yet in hand, so a probe over a streamed index costs one round
// trip per level and no more. A word is at most a few dozen characters, so
// even the worst case is bounded by its length rather than by the index size.

import type { IndexReader } from "./index-reader.js";

/**
 * Occurrences of `text` as a complete word or phrase — 0 if the index has no
 * such entry.
 *
 * The trailing space is what makes it *complete*: the index stores words with
 * their boundary, so walking "car" alone would also count CARTOON, and
 * "car " counts only the word. That is the same rule the search applies when
 * it decides a match has ended, so a probe and a search agree about what a
 * word is.
 */
export async function probeCount(
  reader: IndexReader,
  text: string,
): Promise<number> {
  if (text === "") return 0;
  let node = reader.root();
  let count = reader.count();
  const out: Array<{ ch: number; count: number; next: number }> = [];
  for (const ch of `${text} `) {
    out.length = 0;
    const r = reader.children(node, count, out);
    if (r instanceof Promise) await r;
    const code = ch.charCodeAt(0);
    const child = out.find((c) => c.ch === code);
    if (!child) return 0;
    node = child.next;
    count = child.count;
  }
  return count;
}

/**
 * The same, as a share of the corpus.
 *
 * The relative form is the one worth comparing across indexes: the English
 * Wikipedia index holds 5.7 billion occurrences and the Slovak one a few
 * hundred million, so a raw count means nothing between them while a share
 * means the same thing in both.
 */
export async function probeShare(
  reader: IndexReader,
  text: string,
): Promise<number> {
  const total = reader.count();
  if (total <= 0) return 0;
  return (await probeCount(reader, text)) / total;
}
