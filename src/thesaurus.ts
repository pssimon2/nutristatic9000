// `{like:reluctant}` — the words WordNet groups with a given word.
//
// The design document calls semantic matching the largest gap in the tool, and
// it is: half of hunt work is "seven letters, matches ?A??E??, and clues
// something like reluctant", where either constraint alone is useless and
// together they are decisive. What it wants is a retrieval model; what a
// static site can honestly ship is a thesaurus. So this answers "what else
// means roughly this", which covers the common case, and does not pretend to
// be similarity: LOATH and LOTH come back for RELUCTANT, UNWILLING does not
// unless WordNet puts it in the same sense.
//
// The intersection is the whole value, so the point is that it composes:
// {like:reluctant}&A{7}&.A..E.. is one query rather than two tools.

export type Thesaurus = Map<string, string[]>;

/** Parse tab-separated sense groups into a word -> related-words map. */
export function parseThesaurus(text: string): Thesaurus {
  const out: Thesaurus = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const words = line.split("\t");
    if (words.length < 2) continue;
    for (const word of words) {
      // A word in several senses gets the union of them, so every reading is
      // reachable — the pattern is what narrows it down.
      const seen = out.get(word);
      out.set(word, seen ? [...new Set([...seen, ...words])] : words);
    }
  }
  return out;
}

/** Words sharing a sense with `word`, or null if it isn't in WordNet. */
export function relatedTo(
  t: Thesaurus | null,
  word: string,
): string[] | null {
  return t?.get(word) ?? null;
}

export function needsThesaurus(query: string): boolean {
  return /\{\s*like\b/i.test(query);
}
