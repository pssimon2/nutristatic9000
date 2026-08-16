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

/** An automaton accepting any entry of the list. */
export function listNfa(name: string): Nfa | null {
  const entries = wordList(name);
  if (!entries || entries.length === 0) return null;
  let out: Nfa | null = null;
  for (const entry of entries) {
    const nfa = new Nfa();
    let state = nfa.addState();
    nfa.setStart(state);
    for (const ch of entry) {
      const next = nfa.addState();
      nfa.addArc(state, ch.charCodeAt(0), next);
      state = next;
    }
    nfa.setFinal(state);
    if (out === null) out = nfa;
    else out.union(nfa);
  }
  return out;
}
