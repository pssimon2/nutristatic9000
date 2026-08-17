// What a written query is made of, before the engine sees it.
//
// A query carries a little more than a pattern: the odd construct the page
// wants to annotate results with. That used to be read by regexes scattered
// through web/main.ts — the `{caesar:…}` sniffer was written out twice, four
// lines apart — which put query-language knowledge in the one file that is
// meant to know only about rendering. It lives here now, once.
//
// (The output wrappers `{at …}` and `{rank …}`, and the `;` slot separator,
// were removed from the language 2026-08-17: not useful in practice, and the
// only constructs that could not compose.)

export interface QueryShape {
  /** The engine-level pattern (the query as written, trimmed). */
  pattern: string;
  /**
   * The ciphertext of a *lone* unknown-shift `{caesar:…}`. Only one can be
   * annotated unambiguously: with two, a result satisfies both and there is no
   * single shift to report.
   */
  caesar: string | null;
  /**
   * A lone edit construct over a bare literal — `{del1:beast}`, `{subst1:cargo}`
   * — as the kind, how many edits, and the word. Only when the argument is a
   * plain word: `{del1:{kind:instrument}}` has a set for an argument, and which
   * member a result came from is not something the query text can say.
   *
   * Here for the same reason `caesar` is: what changed is derivable from the
   * result and the query together, so the page can annotate each answer without
   * the engine carrying provenance through the search.
   */
  edit: { kind: string; edits: number; word: string } | null;
  /**
   * A *lone* `{near:…}`, with the neighbour count it asked for. Results are
   * ordered by closeness to this word, and that ordering has to use the same
   * list the pattern was built from — reading the word with a second regex
   * that dropped the count meant `{near 200:king}` built its pattern from 200
   * neighbours and then ordered by the first 64, leaving 136 of them tied.
   *
   * Only one can order the results, for the same reason only one caesar can
   * be annotated.
   */
  near: { word: string; limit: number } | null;
  /** Maximal literal runs, long enough to be worth folding repeats on. */
  literals: string[];
}

/** The default neighbour count, matching what the parser builds with. */
export const NEAR_DEFAULT_LIMIT = 32;

const NEAR = /\{\s*(?:word\.)?near\s*(\d*)\s*:\s*([a-z ]+)\}/gi;

const CAESAR = /\{\s*(?:cipher\.)?caesar\s*:([a-z ]+)\}/gi;

/** `{del1:beast}`, `{subst2:cargo}`, `{edit<=2:cargo}` over a bare word. */
const EDIT = /\{\s*(?:edit\.)?(del|add|subst|edit)\s*(?:<=)?\s*(\d*)\s*:\s*([a-z][a-z ]*)\}/gi;

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

/** Read the annotation-relevant shape of a query. */
export function shapeOfQuery(query: string, minLiteralChars: number): QueryShape {
  const pattern = query.trim();

  CAESAR.lastIndex = 0;
  const found = pattern.match(CAESAR) ?? [];
  let caesar: string | null = null;
  if (found.length === 1) {
    const m = /\{\s*(?:cipher\.)?caesar\s*:([a-z ]+)\}/i.exec(found[0]);
    caesar = m ? m[1].trim() : null;
  }

  NEAR.lastIndex = 0;
  const nears = [...pattern.matchAll(NEAR)];
  const near =
    nears.length === 1
      ? {
          word: nears[0][2].trim(),
          limit: nears[0][1] === "" ? NEAR_DEFAULT_LIMIT : Number(nears[0][1]),
        }
      : null;

  EDIT.lastIndex = 0;
  const edits = [...pattern.matchAll(EDIT)];
  // One only, for the same reason as the caesar: two of them and an annotation
  // cannot say which produced what.
  const edit =
    edits.length === 1
      ? {
          kind: edits[0][1].toLowerCase(),
          edits: edits[0][2] === "" ? 1 : Number(edits[0][2]),
          word: edits[0][3].trim(),
        }
      : null;

  return {
    pattern,
    caesar,
    edit,
    near,
    literals: literalsOf(pattern, minLiteralChars),
  };
}
