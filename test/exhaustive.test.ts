// The search against a brute-force oracle.
//
// The randomized parity test plays the two engines off each other, which is
// powerful and has one blind spot: a bug they share. The restart bug was
// exactly that — the C kernel and the TypeScript driver had the same mistake
// in the same order, so they agreed with each other and were both wrong.
//
// This is an oracle that cannot share a bug with either, because it does no
// searching: enumerate every string in the index, keep the ones the compiled
// automaton accepts, and require the search to return precisely that set.
// Not a sample of it, not a superset — the same set.
//
// Sound only for patterns that cannot match a space. A result may span several
// index entries, joined where the walk restarted at a word boundary, and this
// compares against single entries; a pattern that cannot consume a space
// cannot span. That rules out `.` (which matches anything, spaces included)
// and anything unquoted, since unquoted atoms carry optional space self-loops.
// `A`, `C`, `V`, `#`, `_` and literal letters are all safe.

import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { IndexWalker } from "../src/index-walker.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";
import { compileQuery } from "../src/find-expr.js";
import type { Filter } from "../src/expr-filter.js";

const ctx = new SessionContext();
let reader: IndexReader;
let entries: string[] = [];
/**
 * Every prefix of an index entry that ends in a space.
 *
 * A walk may restart at any space it *reaches*, and it reaches prefixes, not
 * only whole stored strings — so a result spanning word boundaries splits into
 * these, not into entries. Getting that wrong reported "solar s 1st em" as
 * unreachable when it is perfectly reachable.
 */
const spacePrefixes = new Set<string>();

beforeAll(async () => {
  const data = fs.readFileSync("web/public/demo.index");
  reader = await IndexReader.open(new MemorySource(data));
  const walker = await IndexWalker.create(reader, reader.root(), reader.count());
  while (walker.text !== null) {
    const t = walker.text;
    entries.push(t);
    for (let i = 0; i < t.length; ++i) {
      if (t[i] === " ") spacePrefixes.add(t.slice(0, i + 1));
    }
    await walker.next();
  }
}, 60000);

/** Can the index reach `s` — as one segment, or several joined at restarts? */
function reachable(s: string): boolean {
  const ok = new Array(s.length + 1).fill(false);
  ok[0] = true;
  for (let i = 0; i < s.length; ++i) {
    if (!ok[i]) continue;
    for (let j = i; j < s.length; ++j) {
      if (s[j] !== " ") continue;
      if (spacePrefixes.has(s.slice(i, j + 1))) ok[j + 1] = true;
    }
  }
  return ok[s.length];
}

/** Does the compiled filter accept this exact string? */
function accepts(filter: Filter, s: string): boolean {
  let state = filter.startState;
  for (const ch of s) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

/** Every index entry the pattern matches, by inspection rather than search. */
function bruteForce(query: string): string[] {
  const filter = compileQuery(query, ctx);
  // Entries carry their trailing space, which is what compileQuery's appended
  // suffix expects; the search reports them without it.
  return entries.filter((e) => accepts(filter, e)).map((e) => e.trimEnd());
}

async function search(
  query: string,
  steps = 5e6,
  max = 1e6,
): Promise<{ found: string[]; status: string }> {
  const session = new SearchSession(reader, query, ctx);
  const found: string[] = [];
  const status = await session.run(steps, max, (r) => found.push(r.text));
  return { found, status };
}

describe("the search finds exactly what is there", () => {
  // All quoted and free of `.`, so a match is one index entry — see the note
  // at the top for why that is the condition.
  const QUERIES = [
    '"A{5}&C*"',
    '"[aeiou]A{4}"',
    '"C{3}V{2}"',
    '"A{6}&A*eeA*"',
    '"<abcd>"',
    '"{sum=40:A{4}}"',
    '"A{3}#{2}"',
    '"q_*"',
    '"{distinct:A{5}}&V*"',
    '"A{7}&C*&_*"',
  ];

  for (const query of QUERIES) {
    it(`returns every match of ${query} and nothing else`, async () => {
      const expected = bruteForce(query);
      const { found, status } = await search(query);
      // If the search did not finish, "missing" would mean nothing.
      expect(status, `${query} did not exhaust`).toBe("exhausted");

      const foundSet = new Set(found);
      const missing = expected.filter((t) => !foundSet.has(t));
      const extra = found.filter((t) => !expected.includes(t));
      expect(missing, `${query}: in the index and accepted, but not found`)
        .toEqual([]);
      expect(extra, `${query}: returned but not accepted`).toEqual([]);
    }, 60000);
  }

  it("compares against an index that was actually enumerated", () => {
    // Guards the whole file: an empty enumeration makes every "nothing
    // missing" above vacuously true.
    expect(entries.length).toBeGreaterThan(500000);
  });

  it("finds a needle that only one entry matches", async () => {
    const { found } = await search('"nutrimatic"');
    expect(found).toEqual(bruteForce('"nutrimatic"'));
  });
});

// The other half, and the half the file above cannot reach.
//
// Everything before this compares against single index entries, which is only
// sound for patterns that cannot match a space. The restart path — results
// spanning word boundaries — is exactly where the shared bug lived, so it is
// worth an oracle of its own.
describe("results that span word boundaries", () => {
  const SPANNING = [
    "nutr*",
    "e{2}a?",
    "solar s_stem",
    "A{4} A{5}",
    "<aaagmnr>",
    "{sum=52:A*}",
  ];

  for (const query of SPANNING) {
    it(`only returns what ${query} can actually reach`, async () => {
      const filter = compileQuery(query, ctx);
      const { found } = await search(query, 300000, 400);
      expect(found.length, "nothing to check").toBeGreaterThan(0);
      // Soundness has two parts and both matter: the pattern must accept it,
      // and the index must be able to produce it.
      const unaccepted = found.filter((t) => !accepts(filter, `${t} `));
      const unreachable = found.filter((t) => !reachable(`${t} `));
      expect(unaccepted, `${query}: returned but not accepted`).toEqual([]);
      expect(unreachable, `${query}: returned but not in the index`).toEqual([]);
    }, 60000);
  }
});

describe("nothing spanning a word boundary is missed", () => {
  /**
   * Every string over `alphabet` up to `maxLen` that the pattern accepts and
   * the index can reach — the complete answer, worked out without the search
   * taking any part in it. Small alphabets keep this finite; that is the price
   * of an exhaustive check over a path where results are unbounded.
   */
  function everyReachableMatch(
    query: string,
    alphabet: string,
    maxLen: number,
  ): string[] {
    const filter = compileQuery(query, ctx);
    const out: string[] = [];
    const walk = (s: string): void => {
      if (s !== "" && accepts(filter, `${s} `) && reachable(`${s} `)) out.push(s);
      if (s.length >= maxLen) return;
      for (const c of alphabet) walk(s + c);
    };
    walk("");
    // The search never reports a leading, trailing or doubled space.
    return out.filter((t) => !/^ | $|  /.test(t));
  }

  for (const [query, alphabet] of [
    ["e{2}a?", "ea "],
    ["e{2}i?a?", "eia "],
    ["a{2}b?", "ab "],
    ["e{1,2}a", "ea "],
  ] as const) {
    it(`finds every match of ${query} up to six characters`, async () => {
      const expected = everyReachableMatch(query, alphabet, 6);
      expect(expected.length, "oracle found nothing to expect").toBeGreaterThan(1);
      const { found } = await search(query, 5e6, 1e5);
      const got = new Set(found);
      const missing = expected.filter((t) => !got.has(t));
      // One-directional on purpose: the search may legitimately return longer
      // matches than the six characters enumerated here.
      expect(missing, `${query}: reachable and accepted, but not found`)
        .toEqual([]);
    }, 60000);
  }
});
