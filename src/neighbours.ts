// `{near:reluctant}` — words an embedding places close to a given word.
//
// The thesaurus next door only knows words that share a dictionary sense,
// which is why {like:reluctant} gives LOATH but not UNWILLING. An embedding
// model puts those two at 0.75 cosine, and that "merely feels related" sense
// is what clue-solving actually wants.
//
// No model runs here. scripts/build-neighbours.mjs embeds a frequency-ordered
// vocabulary at build time and keeps only the answer the query language needs
// — each word's nearest neighbours — which turns an 8 MB vector table into a
// ~2 MB lookup with no runtime arithmetic and nothing to load but a file.

export interface Neighbours {
  words: string[];
  index: Map<string, number>;
  k: number;
  /** Flat `words.length * k` table of indices into `words`. */
  table: Uint16Array;
}

let loaded: Neighbours | null = null;

const MAGIC = "NSEM1";

/** Parse the binary artifact; throws if it isn't one. */
export function parseNeighbours(buffer: ArrayBuffer): Neighbours {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    ...new Uint8Array(buffer, 0, MAGIC.length),
  );
  if (magic !== MAGIC) throw new Error("not a neighbour table");
  const count = view.getUint32(5, true);
  const k = view.getUint16(9, true);
  const wordBytes = view.getUint32(11, true);
  const header = 15;
  const words = new TextDecoder()
    .decode(new Uint8Array(buffer, header, wordBytes))
    .split("\n");
  const table = new Uint16Array(buffer, header + wordBytes, count * k);
  const index = new Map<string, number>();
  for (let i = 0; i < words.length; ++i) index.set(words[i], i);
  return { words, index, k, table };
}

export function setNeighbours(n: Neighbours | null): void {
  loaded = n;
}

export function neighboursLoaded(): boolean {
  return loaded !== null;
}

/**
 * The `limit` nearest words to `word` (nearest first), or null when the
 * vocabulary doesn't contain it. The word itself leads the list: a query
 * asking for words like X should still match X.
 */
export function nearestTo(word: string, limit = 32): string[] | null {
  if (!loaded) return null;
  const at = loaded.index.get(word);
  if (at === undefined) return null;
  const out = [word];
  for (let i = 0; i < Math.min(limit, loaded.k); ++i) {
    const j = loaded.table[at * loaded.k + i];
    const near = loaded.words[j];
    if (near && near !== word) out.push(near);
  }
  return out;
}

export function needsNeighbours(query: string): boolean {
  return /\{\s*near\b/i.test(query);
}
