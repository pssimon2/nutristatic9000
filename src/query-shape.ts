// What a written query is made of, before the engine sees it.
//
// A query carries more than a pattern: output wrappers that change what is
// shown rather than what matches, slot separators, and the odd construct the
// page wants to annotate results with. All of that used to be read by regexes
// scattered through web/main.ts — the `{caesar:…}` sniffer was written out
// twice, four lines apart — which put query-language knowledge in the one file
// that is meant to know only about rendering.
//
// Peeling happens in a fixed order and each caller must use the same one, or
// `{rank:{at:…}}` and `{at:{rank:…}}` behave differently in the CLI and the
// browser. That order lives here now, once.

import {
  ExtractSpec,
  RankSpec,
  parseExtract,
  parseRank,
} from "./extract-spec.js";

export interface QueryShape {
  /** The engine-level pattern: every output wrapper removed. */
  pattern: string;
  /** `{at …}`, if the query is wrapped in one. */
  extract: ExtractSpec | null;
  /** `{rank …}`, if the query is wrapped in one. */
  rank: RankSpec | null;
  /**
   * The ciphertext of a *lone* unknown-shift `{caesar:…}`. Only one can be
   * annotated unambiguously: with two, a result satisfies both and there is no
   * single shift to report.
   */
  caesar: string | null;
  /** Maximal literal runs, long enough to be worth folding repeats on. */
  literals: string[];
}

/** Split a multi-slot query on ";" — not a character the pattern language uses. */
export function splitSlots(query: string): string[] {
  return query
    .split(";")
    .map((q) => q.trim())
    .filter((q) => q !== "");
}

const CAESAR = /\{\s*(?:cipher\.)?caesar\s*:([a-z ]+)\}/gi;

/**
 * Maximal literal runs in a pattern — plain letters, digits and spaces,
 * ignoring every metacharacter and class (`A`, `C`, `V`, `_`, `#` are
 * uppercase or punctuation and so never appear here).
 */
export function literalsOf(pattern: string, minChars: number): string[] {
  return (pattern.match(/[a-z0-9 ]+/g) ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length >= minChars);
}

/**
 * Peel the output wrappers off a query and report what was found.
 *
 * Throws ExtractError when a wrapper is present but malformed, which is the
 * caller's cue to show the message rather than search.
 */
export function shapeOfQuery(query: string, minLiteralChars: number): QueryShape {
  let pattern = query;
  let extract: ExtractSpec | null = null;
  let rank: RankSpec | null = null;

  const at = parseExtract(pattern);
  if (at) {
    extract = at.spec;
    pattern = at.inner;
  }
  const ranked = parseRank(pattern);
  if (ranked) {
    rank = ranked.spec;
    pattern = ranked.inner;
  }

  CAESAR.lastIndex = 0;
  const found = pattern.match(CAESAR) ?? [];
  let caesar: string | null = null;
  if (found.length === 1) {
    const m = /\{\s*(?:cipher\.)?caesar\s*:([a-z ]+)\}/i.exec(found[0]);
    caesar = m ? m[1].trim() : null;
  }

  return {
    pattern,
    extract,
    rank,
    caesar,
    literals: literalsOf(pattern, minLiteralChars),
  };
}
