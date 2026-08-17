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

import { EPSILON, Nfa } from "./automata.js";
import { Conjunct, isNegated } from "./conjunct.js";
import { Box, parseExprBox } from "./expr-parse.js";
import { ParseError } from "./parse-error.js";
import { SessionContext } from "./session-context.js";
import { IndexReader } from "./index-reader.js";
import { IndexWalker } from "./index-walker.js";
import { ByteSink, IndexWriter, writeEntries } from "./index-writer.js";

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
export async function buildReverseIndex(
  reader: IndexReader,
  sink: ByteSink,
): Promise<number> {
  // Node counts for every word-aligned string: the sum of entry counts it
  // prefixes. This — not the entry list — is what a search reads, and the
  // entry list alone cannot reproduce it: the corpus was windowed to ~40
  // chars per *position*, so a string's left context can overflow one
  // window and arrive as a prefix of the next position's entry instead.
  const c = new Map<string, number>();
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
      const aligned = bare.slice(0, cut);
      c.set(aligned, (c.get(aligned) ?? 0) + count);
      from = cut + 1;
    }
    if (wordFinal) c.set(bare, (c.get(bare) ?? 0) + count);
    await walker.next();
  }
  // Multiplicity of t as a *maximal* occurrence: its count minus its
  // one-word-left extensions' (each occurrence with a left word in reach is
  // counted by exactly one such extension, so m ≥ 0). Emitting rev(t) with
  // m makes reverse prefix counts telescope back to c exactly:
  //   Σ_{t ⊇suffix s} m(t) = Σ c(t) − Σ_{u ⊋ s} c(u) = c(s).
  const leftExt = new Map<string, number>();
  for (const [text, count] of c) {
    const cut = text.indexOf(" ");
    if (cut === -1) continue;
    const shorter = text.slice(cut + 1);
    leftExt.set(shorter, (leftExt.get(shorter) ?? 0) + count);
  }
  const reversed = new Map<string, number>();
  for (const [text, count] of c) {
    const m = count - (leftExt.get(text) ?? 0);
    if (m <= 0) continue;
    const entry = `${[...text].reverse().join("")} `;
    reversed.set(entry, (reversed.get(entry) ?? 0) + m);
  }
  writeEntries(new IndexWriter(sink), [...reversed.entries()]);
  return reversed.size;
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
