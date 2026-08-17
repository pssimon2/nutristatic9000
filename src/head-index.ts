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
): Array<{ text: string; score: number }> {
  const out: Array<{ text: string; score: number }> = [];
  for (let i = 0; i < head.text.length && out.length < limit; ++i) {
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
      out.push({ text: t, score: head.score[i] });
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
): Promise<Array<{ text: string; score: number; note?: string }>> {
  const wanted = filters.length > 0 ? limit * candidateFactor : limit;
  const hits = searchHeadIndex(head, filter, wanted);
  if (filters.length === 0) return hits.slice(0, limit);

  const out: Array<{ text: string; score: number; note?: string }> = [];
  for (const hit of hits) {
    if (out.length >= limit) break;
    const verdict = await applyResultFilters(filters, hit.text, ctx, isWord);
    if (!verdict.keep) continue;
    out.push({
      text: hit.text,
      score: hit.score,
      ...(verdict.notes.length === 0 ? {} : { note: verdict.notes.join("  ") }),
    });
  }
  return out;
}
