// Rhyme and homophone lookups, from the groupings scripts/build-phonetics.mjs
// derives from the CMU pronouncing dictionary.
//
// The blocker for phonetics here is not the automaton — "rhymes with X"
// expands to a finite alternation of spellings, which the engine already
// handles — it is corpus mismatch. The dictionary knows ~135k single English
// words; the index knows Wikipedia n-grams, including proper nouns, phrases
// and vast numbers of tokens no pronouncing dictionary has ever seen. So a
// rhyme query can only ever reach the dictionary's half of the corpus. That
// limit is documented rather than hidden: there is no grapheme-to-phoneme
// fallback here, and a word the dictionary doesn't know says so.

export interface Phonetics {
  /** Spelling -> the groups of spellings it rhymes with. */
  rhyme: Map<string, string[]>;
  /** Spelling -> spellings pronounced identically (including itself). */
  homophone: Map<string, string[]>;
}

let loaded: Phonetics | null = null;

/** Parse the artifact: "R word word …" / "H word word …" lines. */
export function parsePhonetics(text: string): Phonetics {
  const rhyme = new Map<string, string[]>();
  const homophone = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    if (line.length < 3) continue;
    const words = line.slice(2).split(" ");
    const into = line[0] === "R" ? rhyme : line[0] === "H" ? homophone : null;
    if (!into) continue;
    for (const word of words) {
      // A word with several pronunciations belongs to several groups; merge
      // them so every reading is reachable.
      const seen = into.get(word);
      into.set(word, seen ? [...new Set([...seen, ...words])] : words);
    }
  }
  return { rhyme, homophone };
}

export function setPhonetics(p: Phonetics | null): void {
  loaded = p;
}

export function phoneticsLoaded(): boolean {
  return loaded !== null;
}

/** Words rhyming with `word`, or null if the dictionary doesn't know it. */
export function rhymesOf(word: string): string[] | null {
  return loaded?.rhyme.get(word) ?? null;
}

/** Words pronounced like `word`, or null if the dictionary doesn't know it. */
export function homophonesOf(word: string): string[] | null {
  return loaded?.homophone.get(word) ?? null;
}

/** Does this query need the dictionary loaded before it can be compiled? */
export function needsPhonetics(query: string): boolean {
  return /\{\s*(rhyme|homo)\b/i.test(query);
}
