// What one edit turned into what.
//
// `{del1:beast}` answers BEST, EAST, BEAT, BAST — and leaves the reader to work
// out which letter went in each. `{subst1:cargo}` is worse: CARRO, CARGO, CANGO
// differ from the source somewhere, and finding where is exactly the tedium the
// tool is meant to remove.
//
// The change is derivable from the answer and the query together, which is how
// `{caesar:…}` already annotates its results with the shift it found. Nothing in
// the engine has to carry provenance through the search: given "beast" and
// "best", the edit is "-a".
//
// Only for an edit over a bare word. `{del1:{kind:instrument}}` has a set for an
// argument and a result may be one letter off several of its members, so there
// is no single answer to annotate with — and guessing one would be worse than
// saying nothing.

/** How `from` becomes `to` under one edit, or null if it does not. */
function oneEdit(from: string, to: string): string | null {
  if (from === to) return null;
  if (from.length === to.length) {
    // A substitution: exactly one position differs.
    let at = -1;
    for (let i = 0; i < from.length; ++i) {
      if (from[i] === to[i]) continue;
      if (at !== -1) return null;
      at = i;
    }
    return at === -1 ? null : `${from[at]}→${to[at]}`;
  }
  // An insertion or a deletion: the shorter is the longer with one character
  // dropped, which is a single scan with one allowed skip.
  const [short, long] = from.length < to.length ? [from, to] : [to, from];
  if (long.length !== short.length + 1) return null;
  let i = 0;
  while (i < short.length && short[i] === long[i]) ++i;
  for (let j = i; j < short.length; ++j) {
    if (short[j] !== long[j + 1]) return null;
  }
  const ch = long[i];
  return from.length < to.length ? `+${ch}` : `−${ch}`;
}

/**
 * The note for `text`, given the query's edit construct — "beast −a", or null
 * when nothing can be said.
 *
 * Spaces are dropped on both sides before comparing: the index reports "car go"
 * and "cargo" as different answers, and neither is a different *edit*. Only
 * single edits are annotated; `{edit<=2:…}` results are left alone rather than
 * described as a chain, since two edits can be composed several ways and the
 * one chosen would be arbitrary.
 */
export function editNote(
  edit: { kind: string; edits: number; word: string } | null,
  text: string,
): string | null {
  if (edit === null || edit.edits !== 1) return null;
  const from = edit.word.replace(/ /g, "");
  const to = text.replace(/ /g, "");
  const change = oneEdit(from, to);
  return change === null ? null : `${edit.word} ${change}`;
}
