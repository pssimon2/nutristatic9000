// `{iso:…}` — match everything isomorphic to a ciphertext: the same letter
// pattern under a one-to-one substitution. XJXJ matches every ABAB word;
// XJXJ YJKW matches every phrase whose letters repeat exactly where the
// ciphertext's do, which is what "solve the cryptogram" means when the
// answer is something the corpus knows. Results stream by frequency, so the
// most plausible plaintext arrives first, and the mapping that worked is the
// recovered key.
//
// The constraint is not regular — checking it exactly needs the partial
// mapping, which is exponential as automaton state — so it rides hull +
// verify like every other predicate. What is different is that the hull is
// synthesized from the ciphertext rather than compiled from a pattern
// argument:
//
//   * shape for free — exact length, word breaks in the right places;
//   * the most-repeated cipher letters pinned by branch expansion, the same
//     trick `{caesar:…}` uses for shifts: "this letter is c everywhere it
//     occurs", once per candidate letter, unioned. Two pinned letters is 650
//     branches of a fixed chain — cheap, and very selective, because the
//     branchs also exclude the pinned choices from every other position
//     (injectivity against the pins).
//
// The verifier then checks full isomorphism per candidate in O(n), and
// reports the mapping as the note.

import { Nfa } from "./automata.js";
import { MAX_PATTERN_LENGTH } from "./value-constraint.js";

const A = "a".charCodeAt(0);
const SPACE = " ".charCodeAt(0);

/** Arcs the hull may spend: branches × per-chain arcs stays under this. */
const HULL_ARC_BUDGET = 250000;

/** The ciphertext in corpus form, or null if it isn't letters and spaces. */
export function normalizeCipher(arg: string): string | null {
  const s = arg.toLowerCase().trim().replace(/\s+/g, " ");
  if (s === "" || !/^[a-z ]+$/.test(s)) return null;
  if (s.replace(/ /g, "").length > MAX_PATTERN_LENGTH) return null;
  return s;
}

/**
 * The regular over-approximation the search runs on.
 *
 * Pinned letters are chosen greedily by occurrence count — only letters that
 * repeat are worth pinning, since a singleton pin prunes nothing the shape
 * doesn't — and the branch count stops growing at the state budget.
 */
export function isoHull(cipher: string): Nfa {
  const counts = new Map<string, number>();
  for (const ch of cipher) {
    if (ch !== " ") counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const repeated = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([ch]) => ch);
  const pinned: string[] = [];
  let branches = 1;
  for (const ch of repeated) {
    const grown = branches * (26 - pinned.length);
    // A chain's arcs: one per pinned or space position, ~25 per open one.
    let arcs = 0;
    for (const c of cipher) {
      arcs += c === " " || pinned.includes(c) || c === ch ? 1 : 25;
    }
    if (grown * arcs > HULL_ARC_BUDGET) break;
    pinned.push(ch);
    branches = grown;
  }

  const nfa = new Nfa();
  const start = nfa.addState();
  nfa.setStart(start);
  // One chain per injective assignment of the pinned letters.
  const assign = (chosen: number[]) => {
    if (chosen.length < pinned.length) {
      for (let c = 0; c < 26; ++c) {
        if (!chosen.includes(c)) assign([...chosen, c]);
      }
      return;
    }
    const byPin = new Map(pinned.map((ch, i) => [ch, chosen[i]]));
    let state = start;
    for (const ch of cipher) {
      const next = nfa.addState();
      if (ch === " ") {
        nfa.addArc(state, SPACE, next);
      } else if (byPin.has(ch)) {
        nfa.addArc(state, A + byPin.get(ch)!, next);
      } else {
        // Any letter the pins have not claimed: injectivity against them.
        for (let c = 0; c < 26; ++c) {
          if (!chosen.includes(c)) nfa.addArc(state, A + c, next);
        }
      }
      state = next;
    }
    nfa.setFinal(state);
  };
  assign([]);
  return nfa;
}

/**
 * Does `text` decode the ciphertext under some one-to-one mapping? Returns
 * the mapping as a note ("x→t j→h …", first occurrences first), or null.
 */
export function isoMapping(cipher: string, text: string): string | null {
  if (cipher.length !== text.length) return null;
  const to = new Map<string, string>();
  const from = new Map<string, string>();
  const pairs: string[] = [];
  for (let i = 0; i < cipher.length; ++i) {
    const c = cipher[i];
    const p = text[i];
    if (c === " " || p === " ") {
      if (c !== p) return null;
      continue;
    }
    if (p < "a" || p > "z") return null;
    if (to.has(c) ? to.get(c) !== p : from.has(p)) return null;
    if (!to.has(c)) {
      to.set(c, p);
      from.set(p, c);
      pairs.push(`${c}→${p}`);
    }
  }
  return pairs.join(" ");
}
