// Turning a match into what is shown.
//
// The output wrappers are the last thing to happen to a result and the only
// part of the pipeline both front ends had their own copy of: the rank window
// and `{at}` extraction were applied in `cli/find-expr.ts` and in
// `web/main.ts`, separately, each keeping its own count of how many results
// had been seen.
//
// That count is the subtle part. `{rank 200-2000:…}` is a window into the
// *surviving* stream, so it must be advanced only by results that got past the
// predicates, and advanced exactly once each. Two implementations of "exactly
// once" is one more than is safe, and the two were already at risk of drifting
// — the browser additionally collapses near-duplicate variants, and it would
// be easy for a collapsed result to consume a rank on one side and not the
// other.

import { ExtractSpec, RankSpec, applyExtract } from "./extract-spec.js";

/** What a match becomes once the output wrappers have had their say. */
export interface Shown {
  /** What to display: the extracted letters, or the match itself. */
  text: string;
  /** The match it came from, when extraction replaced it. */
  source: string | null;
}

/**
 * Applies `{rank}` and `{at}` to a stream of surviving matches, in that order,
 * and counts ranks itself so every caller counts them the same way.
 */
export class OutputTransform {
  /** Matches that reached the transform — the rank window's coordinate. */
  private seen = 0;

  constructor(
    private readonly extract: ExtractSpec | null,
    private readonly rank: RankSpec | null,
  ) {}

  /** How many surviving matches have been offered so far. */
  get rawRank(): number {
    return this.seen;
  }

  /** Start a new search with the same wrappers. */
  reset(): void {
    this.seen = 0;
  }

  /**
   * What to show for this match, or null if it is not shown.
   *
   * A match outside the rank window still counts towards the window, which is
   * what makes the window a window. A match too short for the requested
   * positions counts too, and is then dropped — matching what both front ends
   * already did, since the rank is taken before extraction is attempted.
   */
  apply(text: string): Shown | null {
    ++this.seen;
    if (this.rank && (this.seen < this.rank.from || this.seen > this.rank.to)) {
      return null;
    }
    if (!this.extract) return { text, source: null };
    const picked = applyExtract(this.extract, text);
    if (picked === null) return null;
    return { text: picked, source: text };
  }
}
