// `{kind:bird}` — every name below a word in WordNet's kind-of hierarchy.
//
// "A seven-letter bird" is the shape of half the crossword clues ever written,
// and it is a question about a category rather than a pattern. BIRD reaches
// 1748 names, TREE reaches hundreds, and the same walk answers any of the
// ~96,000 senses WordNet knows — so this is not a curated list that ships with
// twenty categories in it, it is the whole hierarchy.
//
// The graph ships rather than the answers, because precomputing every closure
// would repeat most of the dictionary once per level of the tree. Expanding
// one is a breadth-first walk over a few thousand nodes, done once per query.

export interface Categories {
  /** Sense index -> the names in that sense. */
  names: string[][];
  /** Sense index -> the senses directly below it. */
  children: number[][];
  /** Name -> the senses it appears in. */
  index: Map<string, number[]>;
}

/** A category wider than this is a whole branch of the dictionary. */
export const MAX_CATEGORY = 4000;

export function parseCategories(text: string): Categories {
  const names: string[][] = [];
  const children: number[][] = [];
  const index = new Map<string, number[]>();
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const words = line.slice(0, tab).split("|");
    const kids = line.slice(tab + 1);
    const at = names.length;
    names.push(words);
    children.push(kids === "" ? [] : kids.split(",").map(Number));
    for (const word of words) {
      const seen = index.get(word);
      if (seen) seen.push(at);
      else index.set(word, [at]);
    }
  }
  return { names, children, index };
}

/**
 * Every name below `word`, including its own. Returns null when WordNet has no
 * such noun or verb, and null when the category is so broad that expanding it
 * would be a way of asking for the dictionary.
 */
export function kindsOf(
  c: Categories | null,
  word: string,
): string[] | null {
  if (!c) return null;
  const roots = c.index.get(word);
  if (!roots) return null;
  const seen = new Set<number>();
  const stack = [...roots];
  const out = new Set<string>();
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const name of c.names[at]) out.add(name);
    if (out.size > MAX_CATEGORY) return null;
    for (const kid of c.children[at]) stack.push(kid);
  }
  return [...out];
}

export function needsCategories(query: string): boolean {
  return /\{\s*kind\b/i.test(query);
}

/**
 * Category names starting with `prefix`, for the completion menu.
 *
 * `{kind:…}` draws on 124,980 WordNet names, and unlike every other argument
 * in the language there is no way to guess one: you cannot tell from outside
 * whether the word is "bird", "bird family" or "birdnesting" — all three
 * exist. So the menu has to say, and this is how it finds out.
 *
 * The search stays here rather than being answered by shipping the names to
 * the page, because 124,980 of them are 1.47 MB of characters and the page has
 * no other use for them. A linear scan over the index keys costs about a
 * millisecond, which is far below the cost of a keystroke.
 *
 * Shorter names first, so "bird" outranks "bird of paradise" — a prefix is
 * usually the start of the word someone means, not of a longer phrase.
 */
export function suggestKinds(
  c: Categories | null,
  prefix: string,
  limit = 12,
): string[] {
  if (!c) return [];
  const want = prefix.trim().toLowerCase();
  // Nothing typed yet, nothing useful to say: 124,980 names cannot be ranked
  // by a prefix that is not there, and sorting them by length just offers
  // "0", "1", "2" — the dataset does contain those.
  if (want === "") return [];
  const hits: string[] = [];
  for (const name of c.index.keys()) {
    if (name.startsWith(want)) hits.push(name);
  }
  hits.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return hits.slice(0, limit);
}
