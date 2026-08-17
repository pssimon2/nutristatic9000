// First-letter sharding: split one search into N disjoint, complete
// walks that can run in parallel.
//
// A result's partition is fixed by the first letter of the whole phrase: the
// restart that lets a phrase span entries re-enters the trie root *within* a
// walk, carrying its crumb, so it never changes which shard a result belongs
// to. A shard therefore filters root children only on its seed expansion
// (SearchDriverOptions.seedLetters) and lets restarts go everywhere — the
// caveat that, ignored, silently loses every phrase needing a restart.
//
// Partitions are weighted by the root children's counts, so shards finish
// together instead of one drawing the whole alphabet's work.

import { ChoiceBuffer, IndexReader } from "./index-reader.js";

/**
 * Split the root's children into `shards` groups of first letters, balanced
 * by count (greedy, largest first — within a few percent of optimal, and the
 * counts are power-law anyway). Fewer groups come back when the root has
 * fewer children than shards asked for.
 */
export async function shardSeedLetters(
  reader: IndexReader,
  shards: number,
): Promise<number[][]> {
  const buf = new ChoiceBuffer();
  const r = reader.childrenInto(reader.root(), reader.count(), buf);
  if (r instanceof Promise) await r;
  const children: Array<{ ch: number; count: number }> = [];
  for (let i = 0; i < buf.n; ++i) {
    children.push({ ch: buf.ch[i], count: buf.count[i] });
  }
  children.sort((a, b) => b.count - a.count);
  const n = Math.max(1, Math.min(shards, children.length));
  const bins: Array<{ letters: number[]; load: number }> = Array.from(
    { length: n },
    () => ({ letters: [], load: 0 }),
  );
  for (const child of children) {
    let best = bins[0];
    for (const bin of bins) {
      if (bin.load < best.load) best = bin;
    }
    best.letters.push(child.ch);
    best.load += child.count;
  }
  return bins.map((b) => b.letters);
}
