// What to say beside a match, derived from the match and the query.
//
// Two kinds of annotation exist. A *predicate* produces its own — the compound
// cuts, the reversal, the syllable count — and that travels with the verdict
// through `applyResultFilters`, so both front ends have always shown it. The
// other kind is derived afterwards from the query and the answer together: which
// Caesar shift maps the ciphertext to this word, which letter an edit changed.
// Nothing has to carry those through the search, which is why they were written
// where they were first needed — in the page.
//
// And so the CLI never showed them. `{caesar:kdhv}` printed "pima" and "slpd"
// with no shift beside them, and `{del1:beast}` printed "best" and "east" with
// no "beast −a", while the page showed both. That is the shape of divergence
// this project keeps finding: one rule, two front ends, one of which quietly
// does less.
//
// So the rule lives here and each front end formats it — the same arrangement
// `result-predicate.ts` already uses for the other kind. M5 wants both kinds on
// one mechanism; this is the half that was duplicated-by-omission.

import type { QueryShape } from "./query-shape.js";
import { editNote } from "./edit-note.js";

/**
 * Which Caesar shift maps the query's ciphertext to `text`, if one does.
 *
 * Only for a lone unknown-shift `{caesar:…}`: with two of them there is no
 * saying which produced what, and `shapeOfQuery` reports the ciphertext only
 * when there is exactly one.
 */
function shiftNote(caesar: string | null, text: string): string | null {
  if (caesar === null) return null;
  const got = text.replace(/ /g, "");
  const src = caesar.replace(/ /g, "");
  if (got.length !== src.length) return null;
  let shift: number | null = null;
  for (let i = 0; i < got.length; ++i) {
    const a = got.charCodeAt(i) - 97;
    const b = src.charCodeAt(i) - 97;
    if (a < 0 || a > 25 || b < 0 || b > 25) return null;
    const s = (a - b + 26) % 26;
    if (shift === null) shift = s;
    else if (shift !== s) return null; // not a single consistent shift
  }
  return shift === null ? null : `caesar +${shift}`;
}

/**
 * The note for one match, or null if the query has nothing to say about it.
 *
 * At most one: a query carrying both a lone caesar and a lone edit is not a
 * shape anyone writes, and picking one over showing two keeps the annotation a
 * single readable phrase rather than a list.
 */
export function derivedNote(shape: QueryShape, text: string): string | null {
  return shiftNote(shape.caesar, text) ?? editNote(shape.edit, text);
}
