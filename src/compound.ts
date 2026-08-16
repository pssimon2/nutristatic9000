// Corpus self-reference: `{compound 2:A{9}}` keeps only the nine-letter
// matches that cut into two words the index actually knows — STARLIGHT into
// STAR and LIGHT. Charades, compounds and hidden-word constructions all fall
// out of it.
//
// This is the one thing no other tool can copy, because no other tool has the
// index. The pattern still does the shape (and still prunes the search); the
// index is then asked, per candidate, whether the pieces are words. Asking
// costs one trie walk per distinct piece, so the work is bounded by the
// candidate's length, not by the corpus.

/** Is this string a word the index knows? May need to fetch bytes. */
export type WordCheck = (word: string) => boolean | Promise<boolean>;

export interface CompoundSpec {
  /** Number of pieces the match must cut into. */
  pieces: number;
}

/** `{compound 2:PATTERN}` → the spec, or null when the spec is malformed. */
export function parseCompoundSpec(spec: string): CompoundSpec | null {
  const m = /^\s*=?\s*(\d+)\s*$/.exec(spec);
  if (!m) return null;
  const pieces = parseInt(m[1], 10);
  // One piece is just "is a word", which the search already guarantees; more
  // than five is a runaway split with no puzzle behind it.
  return pieces >= 2 && pieces <= 5 ? { pieces } : null;
}

/**
 * The pieces `text` cuts into, or null if it doesn't cut into exactly
 * `pieces` indexed words.
 *
 * A compound is a single token, so a match containing a space is never one.
 * Where several cuts work, the most balanced one is returned — the split with
 * the longest shortest piece. A corpus built from web text knows fragments
 * like "ing" and "tion", so CAR+TOON is the interesting reading of CARTOON and
 * C+ARTOON is not; returning the split lets the reader judge rather than
 * forcing an arbitrary frequency threshold.
 */
export async function splitWords(
  text: string,
  pieces: number,
  isWord: WordCheck,
): Promise<string[] | null> {
  if (text.includes(" ") || text.length < pieces) return null;

  const memo = new Map<number, string[] | null>();
  const key = (i: number, k: number) => i * (pieces + 1) + k;
  const worst = (parts: string[]) =>
    parts.reduce((m, p) => Math.min(m, p.length), Infinity);

  const go = async (i: number, k: number): Promise<string[] | null> => {
    if (k === 0) return i === text.length ? [] : null;
    if (i >= text.length) return null;
    const cached = memo.get(key(i, k));
    if (cached !== undefined) return cached;
    let best: string[] | null = null;
    const last = text.length - (k - 1); // every remaining piece needs a char
    for (let j = i + 1; j <= last; ++j) {
      const head = text.slice(i, j);
      if (!(await isWord(head))) continue;
      const rest = await go(j, k - 1);
      if (!rest) continue;
      const candidate = [head, ...rest];
      if (!best || worst(candidate) > worst(best)) best = candidate;
    }
    memo.set(key(i, k), best);
    return best;
  };

  return go(0, pieces);
}

/** Whether `text` cuts into exactly `pieces` indexed words. */
export async function splitsInto(
  text: string,
  pieces: number,
  isWord: WordCheck,
): Promise<boolean> {
  return (await splitWords(text, pieces, isWord)) !== null;
}
