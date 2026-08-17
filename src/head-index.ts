// The head of the index: its highest-scoring entries, small enough to hold.
//
// A 1.3 GB index streamed over HTTP Range answers a plain `A{5}` with 46
// results for 64 MB of transfer, and answers `{palindrome:A{5}}` with nothing
// at all — not because the search is wrong but because the answers are
// scattered the length of the trie, and a best-first walk pays a round trip
// for each new region it reaches. Measured on the deployed index, the queries
// on the recipes page that came back empty needed 1,695 steps and 491 steps
// to their first match; the transfer budget ran out at 412.
//
// But those answers are all *common* entries — CHICKEN, LEVEL, SEPTEMBER,
// ARTICLE — and the top half-million entries of the index are 3.7 MB
// compressed. Fetched once, they answer nearly every query on the site
// instantly and without touching the index at all.
//
// This is not a cache or an approximation of the search: the file is the exact
// prefix of what the same best-first walk emits, so searching it returns the
// same answers in the same order the index would have, and stops where the
// file stops. Past that the real search takes over, unchanged.
//
// Scores are stored to five significant digits, one more than the page ever
// displays. Keeping them exact would add about a megabyte over the wire to
// change nothing anybody sees, and the order does not depend on the last
// digits — entries that close together are ties the search already emits in
// arbitrary order.

import type { Filter } from "./expr-filter.js";
import type { FilterSpec } from "./result-filter.js";
import type { SessionContext } from "./session-context.js";
import type { WordCheck } from "./compound.js";
import { applyResultFilters } from "./result-predicate.js";

export interface HeadIndex {
  /** Entries in the order the index search emits them: best score first. */
  readonly text: string[];
  /** Score of each entry, parallel to `text`. */
  readonly score: Float64Array;
}

/** One `text<TAB>score` line per entry, in descending score order. */
export function parseHeadIndex(source: string): HeadIndex {
  const lines = source.split("\n");
  const text: string[] = [];
  const score = new Float64Array(lines.length);
  let n = 0;
  for (const line of lines) {
    if (line === "") continue;
    const tab = line.lastIndexOf("\t");
    if (tab < 1) continue;
    const value = Number(line.slice(tab + 1));
    if (!Number.isFinite(value)) continue;
    text.push(line.slice(0, tab));
    score[n++] = value;
  }
  return { text, score: score.subarray(0, n) };
}

/**
 * Entries the filter accepts, best score first.
 *
 * Linear over the head — half a million automaton walks of a short string,
 * which costs a few tens of milliseconds and no network at all. `limit` stops
 * it early, since the caller only ever wants a page.
 */
export function searchHeadIndex(
  head: HeadIndex,
  filter: Filter,
  limit: number,
  from = 0,
): Array<{ text: string; score: number; at: number }> {
  const out: Array<{ text: string; score: number; at: number }> = [];
  for (let i = from; i < head.text.length && out.length < limit; ++i) {
    const t = head.text[i];
    let state = filter.startState;
    let ok = true;
    // The trailing space compileQuery appends: entries are stored without it.
    for (let j = 0; j <= t.length; ++j) {
      state = filter.transition(state, j === t.length ? 0x20 : t.charCodeAt(j));
      if (state < 0) {
        ok = false;
        break;
      }
    }
    if (ok && filter.isAccepting(state)) {
      // `at` is where this entry sits in the head, so a caller paging through
      // can resume after it rather than re-scanning from the top.
      out.push({ text: t, score: head.score[i], at: i });
    }
  }
  return out;
}

/**
 * A page of results from the head, with the result predicates applied.
 *
 * The head holds *candidates*: it answers the automaton half of a query, and
 * anything checked on a finished match — `{palindrome:…}`, `{compound …}` —
 * still has to be applied afterwards, exactly as the index path applies it.
 * Leaving that out served "of the" as a palindrome.
 *
 * Because a predicate can reject nearly everything, this reads well past
 * `limit` candidates when there are predicates, and stops at `limit`
 * survivors. `null` means "not answerable from the head" — the caller should
 * run the real search.
 */
export async function headPage(
  head: HeadIndex,
  filter: Filter,
  filters: FilterSpec[],
  ctx: SessionContext,
  isWord: WordCheck,
  limit: number,
  candidateFactor = 40,
  from = 0,
): Promise<{
  results: Array<{ text: string; score: number; note?: string }>;
  /** Where to resume: one past the last entry looked at. */
  next: number;
}> {
  const wanted = filters.length > 0 ? limit * candidateFactor : limit;
  const hits = searchHeadIndex(head, filter, wanted, from);
  const end = (i: number) =>
    hits.length === 0 ? head.text.length : hits[i].at + 1;
  if (filters.length === 0) {
    const taken = hits.slice(0, limit);
    return {
      results: taken.map(({ text, score }) => ({ text, score })),
      next: taken.length === 0 ? head.text.length : end(taken.length - 1),
    };
  }

  const out: Array<{ text: string; score: number; note?: string }> = [];
  let last = head.text.length;
  for (const hit of hits) {
    if (out.length >= limit) break;
    const verdict = await applyResultFilters(filters, hit.text, ctx, isWord);
    if (!verdict.keep) continue;
    last = hit.at + 1;
    out.push({
      text: hit.text,
      score: hit.score,
      ...(verdict.notes.length === 0 ? {} : { note: verdict.notes.join("  ") }),
    });
  }
  return { results: out, next: out.length === 0 ? head.text.length : last };
}

/**
 * The word test `{compound …}` and `{reversible …}` need, answered from the
 * head instead of the index.
 *
 * Both constructs ask whether a piece is a word, and both answer it by
 * frequency: a piece counts if it carries at least `minShare` of the corpus
 * (see src/index-words.ts for why presence alone is not enough). Over a
 * streamed index that is a trie walk per distinct piece, each possibly a round
 * trip, and a page of candidates runs to tens of thousands of them —
 * `{compound 2:A{9}}` spent a minute on the deployed site and still finished
 * empty.
 *
 * But the head is sorted by exactly the quantity those floors are expressed
 * in, so it answers them outright whenever it reaches below the floor: if the
 * lowest score in the head is under `minShare * total`, then every word above
 * the floor is *in* the head, and absence from it is proof of failing the
 * floor rather than a gap in what we hold. That makes this identical to the
 * index-backed check, not an approximation of it — and free.
 *
 * It holds with room to spare on every index the site serves. The floors are
 * 1e-5 and 1e-6 of the corpus; measured across all 22 languages the head
 * reaches between 3x and 30x below the lower of the two — German, the tightest,
 * floors a reversal at 1968 and holds entries down to 694.
 *
 * `fallback` covers the case that leaves: a caller asking about a share so
 * small the head cannot rule it out, or plain presence (`minShare` 0), which
 * the head can never answer negatively.
 *
 * It also applies the suffix test below, which frequency alone cannot do.
 */
/**
 * Least of a piece's weight that must come from it standing on its own,
 * rather than from words that merely end with it.
 *
 * A frequency floor cannot tell a suffix from a short word, and measurably so:
 * on English Wikipedia "ed" carries 8.6e-5 of the corpus and "box" carries
 * 8.3e-5, so any floor that rejects one rejects the other. That is why
 * {compound 2:A{9}} answered "publish·ed" and "ment·ioned", and
 * {compound 3:A{12}} answered "relation·sh·ip".
 *
 * What separates them is not how often the piece occurs but *where*. Measured
 * on the same corpus, as standalone weight over the weight of words ending in
 * it:
 *
 *   suffixes    tion 3.7e-5   ing 3.3e-4   ment 7.3e-4   ed 2.3e-3
 *               sh 1.1e-2     al 1.7e-2    ness 7.4e-3   er 4.0e-4
 *   words       port 8.4e-2   age 8.6e-2   ship 1.1e-1   land 1.3e-1
 *               hood 1.3e-1   man 1.7e-1   box 4.8e-1    keep 3.4e+2
 *
 * Three orders of magnitude between the two groups, and nothing between
 * 1.7e-2 and 8.4e-2. This sits in that gap, nearer the suffix end so that a
 * genuine piece has room: every word above is at least 2.8x clear of it.
 *
 * It is a threshold, not morphology. "ton" (8.1e-3, from Washington and
 * Hamilton) fails it and is a word; a suffix common enough to stand alone
 * would pass. It removes what was actually visible.
 *
 * Only suffixes. The mirror of this — standalone weight over the weight of
 * words *starting* with the piece — was measured on the same corpus and does
 * not separate: "per" scores 1.9e-1 and "com" 1.3e-1, above the genuine
 * "broad" (1.7e-1) and "sea" (1.0e-1), with "trans" (2.8e-2) and "foot"
 * (4.2e-2) below even "pre" (3.0e-2). There is no threshold, so junk first
 * pieces — ap·pointed, gene·rally — survive this. Suffixes are a small closed
 * set attached to nearly everything, which is what makes their ratio collapse;
 * Latin prefixes are fused into words rather than productive, so theirs does
 * not.
 *
 * This needs the head, so it applies wherever the head is loaded — which is
 * every search over a streamed index, and not one over an index already on
 * the device, where the pieces are judged by frequency alone as before. The
 * weight of words ending in a string is not something the index answers
 * without enumerating it.
 */
export const MIN_STANDALONE_RATIO = 0.03;

/**
 * Longest piece the suffix test looks at. The debris is all short — the
 * longest that failed above is "ness" — and beyond this the ratio stops
 * meaning anything, since almost nothing ends in a given seven-letter string
 * except that string.
 */
const MAX_SUFFIX_TESTED = 6;

export function headWordChecker(
  head: HeadIndex,
  total: number,
  fallback: WordCheck,
): WordCheck {
  // Single-word entries only. Phrases are entries too ("of the"), and are
  // never what a compound piece or a reversal is checked against.
  const score = new Map<string, number>();
  for (let i = 0; i < head.text.length; ++i) {
    const t = head.text[i];
    if (!t.includes(" ")) score.set(t, head.score[i]);
  }
  const lowest =
    head.score.length === 0 ? Infinity : head.score[head.score.length - 1];

  // Weight of the words ending in each short string — built on first use,
  // since most queries never ask a word question at all. Only over the words
  // themselves, which is a small part of the head: 66,548 of English's
  // 500,000 entries, the rest being phrases.
  let ending: Map<string, number> | null = null;
  const endingWeight = (suffix: string): number => {
    if (ending === null) {
      ending = new Map();
      for (const [w, s] of score) {
        for (let n = 2; n <= MAX_SUFFIX_TESTED && n < w.length; ++n) {
          const suf = w.slice(-n);
          ending.set(suf, (ending.get(suf) ?? 0) + s);
        }
      }
    }
    return ending.get(suffix) ?? 0;
  };

  return (word: string, minShare = 0): boolean | Promise<boolean> => {
    const floor = minShare * total;
    if (floor < lowest) return fallback(word, minShare);
    const alone = score.get(word) ?? 0;
    if (alone < floor) return false;
    if (word.length > MAX_SUFFIX_TESTED) return true;
    return alone >= MIN_STANDALONE_RATIO * endingWeight(word);
  };
}
