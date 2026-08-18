// The reverse-index sidecar: the same corpus with every stored phrase
// reversed, and the machinery to search it.
//
// A suffix-anchored pattern (`.*tion`) is the trie's worst case: no prefix to
// walk down, every path a candidate until its last letter. Reversed, the
// anchor becomes a prefix (`noit.*`) and the walk prunes like any other
// query. The index byte format stays frozen: the reverse index is an
// ordinary `.index` file built from reversed entries, served beside the
// original as an opt-in sidecar.
//
// Search equivalence: an automaton's reversal accepts exactly the reversed
// language, complement commutes with reversal, and the window sets mirror —
// a phrase spanning k windows forward spans k reversed windows backward — so
// a reverse search returns the same strings at the same scores, spelled
// backwards. The caller re-reverses for display and runs predicates on the
// real text.

import { ALPHABET, EPSILON, Nfa } from "./automata.js";
import { Conjunct, isNegated } from "./conjunct.js";
import { Box, parseExprBox } from "./expr-parse.js";
import { type Filter, makeFilter } from "./expr-filter.js";
import { compileConjuncts } from "./find-expr.js";
import { ParseError } from "./parse-error.js";
import { SessionContext } from "./session-context.js";
import { IndexReader } from "./index-reader.js";
import { IndexWalker } from "./index-walker.js";
import { ByteSink, IndexWriter } from "./index-writer.js";

/** A stored entry, reversed, keeping the trailing-space convention. */
export function reverseEntry(text: string): string {
  const bare = text.replace(/ +$/, "");
  return [...bare].reverse().join("") + " ";
}

/** A displayed match, un-reversed. */
export function unreverseText(text: string): string {
  return [...text.replace(/ +$/, "")].reverse().join("");
}

/**
 * Build the reverse index of `reader` into `sink`. Holds every entry in
 * memory — an offline build-time cost, like the forward index's own.
 *
 * Not a naive per-entry reversal: the forward index stores every *word
 * suffix* of each corpus window ("the quick brown fox" also stores "quick
 * brown fox", "brown fox", "fox"), which is what makes prefix counts equal
 * occurrence counts. Reversing those entries directly counts one occurrence
 * once per window it appears in. Instead the windows' own multiplicities are
 * recovered — an entry's stored count minus the counts of its one-word-left
 * extensions, since every longer window contains it through exactly one such
 * extension — and each window with a positive multiplicity is re-suffixed in
 * reverse. The reverse index then holds exactly the mirrored window set, and
 * reverse prefix counts equal forward ones.
 */
/**
 * A string→count map that scales past V8's ~16.7M-entries-per-Map limit by
 * sharding on the first two characters. A large index has tens of millions
 * of word-aligned strings, which is exactly where the single Map died.
 */
class BigCounter {
  private readonly shards = new Map<string, Map<string, number>>();
  size = 0;

  private shard(key: string): Map<string, number> {
    const k = key.slice(0, 2);
    let m = this.shards.get(k);
    if (m === undefined) {
      m = new Map();
      this.shards.set(k, m);
    }
    return m;
  }

  get(key: string): number | undefined {
    return this.shard(key).get(key);
  }

  add(key: string, by: number): void {
    const m = this.shard(key);
    const had = m.get(key);
    if (had === undefined) ++this.size;
    m.set(key, (had ?? 0) + by);
  }

  *entries(): IterableIterator<[string, number]> {
    for (const m of this.shards.values()) yield* m.entries();
  }

  /**
   * Entries in global lexicographic order without one giant array: every
   * member of a shard starts with the shard's two-character key, so sorting
   * the keys and then each shard sorts the whole set. The largest corpus has
   * ~100M reversed entries; a flat array of them is exactly the allocation
   * that cannot be made.
   */
  *sortedEntries(): IterableIterator<[string, number]> {
    const keys = [...this.shards.keys()].sort();
    for (const k of keys) {
      const entries = [...this.shards.get(k)!.entries()];
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      yield* entries;
    }
  }

  /** Drop everything, so the next phase's memory does not sit on this one's. */
  clear(): void {
    this.shards.clear();
    this.size = 0;
  }
}

export async function buildReverseIndex(
  reader: IndexReader,
  sink: ByteSink,
): Promise<number> {
  // Node counts for every word-aligned string: the sum of entry counts it
  // prefixes. This — not the entry list — is what a search reads, and the
  // entry list alone cannot reproduce it: the corpus was windowed to ~40
  // chars per *position*, so a string's left context can overflow one
  // window and arrive as a prefix of the next position's entry instead.
  const c = new BigCounter();
  const walker = await IndexWalker.create(reader, reader.root(), reader.count());
  while (walker.text !== null) {
    const count = walker.count;
    // Word-aligned prefixes end at each internal space; the full text joins
    // them only when it is genuinely word-final (a trailing space in the
    // stored form). An entry ending without one was truncated mid-word by
    // the window cap, and no match can end there — the required
    // trailing-space suffix has nowhere to go.
    const wordFinal = walker.text.endsWith(" ");
    const bare = walker.text.replace(/ +$/, "");
    let from = 0;
    for (;;) {
      const cut = bare.indexOf(" ", from);
      if (cut === -1) break;
      c.add(bare.slice(0, cut), count);
      from = cut + 1;
    }
    if (wordFinal) c.add(bare, count);
    await walker.next();
  }
  // Multiplicity of t as a *maximal* occurrence: its count minus its
  // one-word-left extensions' (each occurrence with a left word in reach is
  // counted by exactly one such extension, so m ≥ 0). Emitting rev(t) with
  // m makes reverse prefix counts telescope back to c exactly:
  //   Σ_{t ⊇suffix s} m(t) = Σ c(t) − Σ_{u ⊋ s} c(u) = c(s).
  const leftExt = new BigCounter();
  for (const [text, count] of c.entries()) {
    const cut = text.indexOf(" ");
    if (cut === -1) continue;
    leftExt.add(text.slice(cut + 1), count);
  }
  const reversed = new BigCounter();
  for (const [text, count] of c.entries()) {
    const m = count - (leftExt.get(text) ?? 0);
    if (m <= 0) continue;
    reversed.add(`${[...text].reverse().join("")} `, m);
  }
  // The counters are this build's memory ceiling; the write needs only the
  // reversed set, streamed in sorted order rather than materialised.
  c.clear();
  leftExt.clear();
  const writer = new IndexWriter(sink);
  let prev = "";
  let written = 0;
  for (const [text, count] of reversed.sortedEntries()) {
    let same = 0;
    const limit = Math.min(prev.length, text.length);
    while (same < limit && prev.charCodeAt(same) === text.charCodeAt(same)) {
      ++same;
    }
    writer.next(text, same, count);
    prev = text;
    ++written;
  }
  writer.next(null, 0, 0);
  return written;
}

/** The NFA accepting exactly the reversed language. */
export function reverseNfa(nfa: Nfa): Nfa {
  const out = new Nfa();
  for (let s = 0; s < nfa.arcs.length; ++s) out.addState();
  for (let s = 0; s < nfa.arcs.length; ++s) {
    for (const a of nfa.arcs[s]) out.addArc(a.to, a.label, s);
  }
  const finals = [...nfa.finals];
  if (finals.length === 1) {
    out.setStart(finals[0]);
  } else {
    const start = out.addState();
    out.setStart(start);
    for (const f of finals) out.addArc(start, EPSILON, f);
  }
  if (nfa.start !== -1) out.setFinal(nfa.start);
  return out;
}

const CODE_SPACE = 0x20;

/**
 * Compile a query for a reverse index: parse forward, reverse every conjunct,
 * then append the trailing space the search requires — after the reversal,
 * because the reverse index's entries end (not start) with their space.
 * Negation reverses inside its complement; the two commute.
 */
export function compileConjunctsReversed(
  query: string,
  ctx: SessionContext,
): Conjunct[] {
  const box = new Box();
  const p = parseExprBox(query, 0, box, false, ctx);
  if (p === null || p !== query.length) {
    throw new ParseError(p === null ? query : query.slice(p));
  }
  const reversed: Conjunct[] = box.and.map((c) => {
    const inner = isNegated(c) ? c.not : c;
    if (inner.finalWeight !== undefined) {
      throw new ParseError(
        "",
        "a weighted construct ({~…}, graded {edit:…}) cannot run against a " +
          "reverse index — its weights ride the accepting states the " +
          "reversal turns into starts",
      );
    }
    const rev = reverseNfa(inner);
    return isNegated(c) ? { not: rev } : rev;
  });
  for (const c of reversed) {
    const nfa = isNegated(c) ? c.not : c;
    appendSpace(nfa);
  }
  if (reversed.length > 0 && !reversed.some((c) => !isNegated(c))) {
    // Same soundness argument as the forward compile: restrict to strings
    // ending in the boundary space (see compileConjuncts).
    const all = new Nfa();
    const loop = all.addState();
    const end = all.addState();
    all.setStart(loop);
    all.setFinal(end);
    for (let c2 = 0x30; c2 <= 0x39; ++c2) all.addArc(loop, c2, loop);
    for (let c2 = 0x61; c2 <= 0x7a; ++c2) all.addArc(loop, c2, loop);
    all.addArc(loop, CODE_SPACE, loop);
    all.addArc(loop, CODE_SPACE, end);
    reversed.push(all);
  }
  return reversed;
}

/** Concat one literal space, the way the forward compile's suffix does. */
function appendSpace(nfa: Nfa): void {
  const space = new Nfa();
  const a = space.addState();
  const b = space.addState();
  space.setStart(a);
  space.setFinal(b);
  space.addArc(a, CODE_SPACE, b);
  nfa.concat(space);
}

/** How many symbols the filter accepts as a first character. */
function startFanout(filter: Filter): number {
  let n = 0;
  for (const ch of ALPHABET) {
    if (ch !== EPSILON && filter.transition(filter.startState, ch) >= 0) ++n;
  }
  return n;
}

/**
 * Would this query walk better reversed? True when the reversed automaton
 * pins more of its first letters than the forward one — the suffix-anchored
 * case (`.*tion` opens 37 ways forward and one way reversed). False for
 * anything that cannot reverse (weighted constructs) or does not parse; the
 * forward path then reports whatever is wrong.
 */
export function reverseFavored(query: string, ctx: SessionContext): boolean {
  try {
    const fwd = makeFilter(compileConjuncts(query, ctx));
    const rev = makeFilter(compileConjunctsReversed(query, ctx));
    return startFanout(rev) < startFanout(fwd);
  } catch {
    return false;
  }
}

/** The reverse sidecar's conventional name beside `x.index`: `x.rindex`. */
export function reverseSidecarName(indexName: string): string {
  return indexName.replace(/\.index$/, "") + ".rindex";
}
