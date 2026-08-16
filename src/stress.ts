// Syllable counts and stress shapes, from the CMU pronouncing dictionary.
//
// `{syllables=3:A*}` is the crossword question ("three syllables, seven
// letters"); `{stress:100:A*}` is the metrical one, a dactyl. Neither can be
// an automaton — how a word is said is not a property of how it is spelled —
// so both are checked on finished matches, one lookup per word.
//
// A shape is one digit per syllable: 1 primary, 2 secondary, 0 unstressed.
// Its length is the syllable count, so one string answers both questions.

export type Stress = Map<string, string>;

export function parseStress(text: string): Stress {
  const out: Stress = new Map();
  for (const line of text.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    out.set(line.slice(0, sp), line.slice(sp + 1).trim());
  }
  return out;
}

/**
 * The stress shape of a phrase: each word's shape, joined. Null when any word
 * is missing, since a partial count would be wrong rather than approximate.
 */
export function shapeOf(s: Stress | null, text: string): string | null {
  if (!s) return null;
  let out = "";
  for (const word of text.split(" ")) {
    if (!word) continue;
    const shape = s.get(word);
    if (!shape) return null;
    out += shape;
  }
  return out || null;
}

export function syllablesOf(s: Stress | null, text: string): number | null {
  return shapeOf(s, text)?.length ?? null;
}

export function needsStress(query: string): boolean {
  return /\{\s*(syllables|stress)\b/i.test(query);
}
