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

let loaded: Categories | null = null;

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

export function setCategories(c: Categories | null): void {
  loaded = c;
}

export function categoriesLoaded(): boolean {
  return loaded !== null;
}

/**
 * Every name below `word`, including its own. Returns null when WordNet has no
 * such noun or verb, and null when the category is so broad that expanding it
 * would be a way of asking for the dictionary.
 */
export function kindsOf(word: string): string[] | null {
  if (!loaded) return null;
  const roots = loaded.index.get(word);
  if (!roots) return null;
  const seen = new Set<number>();
  const stack = [...roots];
  const out = new Set<string>();
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const name of loaded.names[at]) out.add(name);
    if (out.size > MAX_CATEGORY) return null;
    for (const kid of loaded.children[at]) stack.push(kid);
  }
  return [...out];
}

export function needsCategories(query: string): boolean {
  return /\{\s*kind\b/i.test(query);
}
