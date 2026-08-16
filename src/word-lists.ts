// Named category lists: `{list:greek}` matches any Greek letter name,
// `.*{list:nato}.*` finds one hidden inside a phrase. Hunts run on categories,
// and a category is just a large alternation — zero engine cost, since the
// result is an ordinary automaton like any other literal.
//
// Entries are stored the way the corpus stores text (lowercase, apostrophes
// dropped, every other separator a single space) so multiword entries match.

import { Nfa } from "./automata.js";

/** Normalise like corpus.ts: apostrophes vanish, other punctuation splits. */
export function normalizeEntry(s: string): string {
  return s
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const RAW: Record<string, string> = {
  greek:
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi " +
    "omicron pi rho sigma tau upsilon phi chi psi omega",
  nato:
    "alfa bravo charlie delta echo foxtrot golf hotel india juliett kilo lima " +
    "mike november oscar papa quebec romeo sierra tango uniform victor whiskey " +
    "xray yankee zulu",
  chesspieces: "king queen rook bishop knight pawn",
  planets: "mercury venus earth mars jupiter saturn uranus neptune",
  months:
    "january february march april may june july august september october " +
    "november december",
  days: "monday tuesday wednesday thursday friday saturday sunday",
  zodiac:
    "aries taurus gemini cancer leo virgo libra scorpio sagittarius capricorn " +
    "aquarius pisces",
  suits: "hearts diamonds clubs spades",
  compass: "north south east west northeast northwest southeast southwest",
};

/** Alternative spellings that should resolve to the same list. */
const ALIASES: Record<string, string> = {
  greekletters: "greek",
  natoalphabet: "nato",
  chess: "chesspieces",
  weekdays: "days",
  cardsuits: "suits",
  directions: "compass",
};

const CACHE = new Map<string, string[]>();

/** The entries of a named list, or null if there is no such list. */
export function wordList(name: string): string[] | null {
  const key = ALIASES[name] ?? name;
  if (CACHE.has(key)) return CACHE.get(key)!;
  const raw = RAW[key];
  if (!raw) return null;
  const entries = raw.split(" ").map(normalizeEntry).filter((e) => e !== "");
  CACHE.set(key, entries);
  return entries;
}

export function listNames(): string[] {
  return Object.keys(RAW).sort();
}

/**
 * An automaton accepting any of the given entries, shaped as a prefix trie.
 *
 * The obvious construction — one chain per entry, unioned — gives the same
 * language but one start-state branch per entry, so a 1,700-word category
 * starts every subset closure with 1,700 live NFA states. Sharing prefixes
 * roughly halves the automaton on real category data (bird: 26,276 arcs to
 * 14,905) and, more importantly, collapses that fan-out: the closure after
 * reading "co" is whatever "co…" leads to, not a thousand dead branches the
 * lazy DFA has to carry.
 *
 * Duplicate entries collapse for free, and an entry that is a prefix of
 * another is simply an accepting node on the way through.
 */
export function entriesNfa(entries: string[]): Nfa | null {
  if (entries.length === 0) return null;
  const nfa = new Nfa();
  const root = nfa.addState();
  nfa.setStart(root);
  // Child lookup per node, since Nfa keeps arcs as a list.
  const children: Array<Map<number, number>> = [new Map()];
  for (const entry of entries) {
    let state = root;
    for (const ch of entry) {
      const c = ch.charCodeAt(0);
      let next = children[state].get(c);
      if (next === undefined) {
        next = nfa.addState();
        children.push(new Map());
        nfa.addArc(state, c, next);
        children[state].set(c, next);
      }
      state = next;
    }
    nfa.setFinal(state);
  }
  return nfa;
}

/**
 * An automaton accepting any entry of a named list, or — when the argument
 * carries commas — of a list written inline: `{list:red,green,blue}`. Hunts
 * run on categories nobody could ship in advance, and an inline list needs no
 * settings screen and travels in the URL like the rest of the query.
 */
export function listNfa(nameOrEntries: string): Nfa | null {
  if (nameOrEntries.includes(",")) {
    return entriesNfa(
      nameOrEntries.split(",").map(normalizeEntry).filter((e) => e !== ""),
    );
  }
  const entries = wordList(
    nameOrEntries.trim().toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
  return entries ? entriesNfa(entries) : null;
}
