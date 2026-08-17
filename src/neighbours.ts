import { mentionsConstruct } from "./constructs.js";
// `{near:reluctant}` — words an embedding places close to a given word.
//
// The thesaurus next door only knows words that share a dictionary sense,
// which is why {like:reluctant} gives LOATH but not UNWILLING. An embedding
// model puts those two at 0.75 cosine, and that "merely feels related" sense
// is what clue-solving actually wants.
//
// No model runs here. scripts/build-neighbours.mjs computes each word's
// nearest neighbours at build time and ships only those, which turns a vector
// table into a lookup with no runtime arithmetic and nothing to load but a
// file.
//
// The vectors are ConceptNet Numberbatch rather than a sentence-transformer.
// Benchmarked against all-MiniLM-L6-v2, all-mpnet-base-v2, bge-base-en-v1.5,
// gte-base and GloVe on WordNet gold pairs, it retrieved a third more
// synonyms than the best transformer (38% of gold synonyms in the top 40, vs
// 29%) — it is a word model retrofitted with relational knowledge, which is
// this question rather than sentence similarity.
//
// Its one weakness is that ConceptNet links antonyms as related, so opposites
// ranked higher than in any other model tested. The build strips the pairs
// WordNet names, which costs no recall. Opposites WordNet does not list still
// get through: no embedding separates them by itself.

export interface Neighbours {
  words: string[];
  index: Map<string, number>;
  k: number;
  /** Flat `words.length * k` table of indices into `words`. */
  table: Uint16Array;
}

const MAGIC = "NSEM2";
const HEADER = 16;

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
  // Header and word block are both padded even, so the index array starts on
  // a 2-byte boundary — a Uint16Array view cannot begin at an odd offset.
  const words = new TextDecoder()
    .decode(new Uint8Array(buffer, HEADER, wordBytes))
    .split("\n")
    .filter((w) => w !== "");
  const table = new Uint16Array(buffer, HEADER + wordBytes, count * k);
  const index = new Map<string, number>();
  for (let i = 0; i < words.length; ++i) index.set(words[i], i);
  return { words, index, k, table };
}

/**
 * The `limit` nearest words to `word` (nearest first), or null when the
 * vocabulary doesn't contain it. The word itself leads the list: a query
 * asking for words like X should still match X.
 */
export function nearestTo(
  n: Neighbours | null,
  word: string,
  limit = 32,
): string[] | null {
  if (!n) return null;
  const at = n.index.get(word);
  if (at === undefined) return null;
  const out = [word];
  for (let i = 0; i < Math.min(limit, n.k); ++i) {
    const j = n.table[at * n.k + i];
    const near = n.words[j];
    if (near && near !== word) out.push(near);
  }
  return out;
}

export function needsNeighbours(query: string): boolean {
  return mentionsConstruct(query, ["near"]);
}
