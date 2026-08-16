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

beforeAll(async () => {
  const data = fs.readFileSync("web/public/demo.index");
  reader = await IndexReader.open(new MemorySource(data));
  const walker = await IndexWalker.create(reader, reader.root(), reader.count());
  while (walker.text !== null) {
    entries.push(walker.text);
    await walker.next();
  }
}, 60000);

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

async function search(query: string): Promise<{ found: string[]; status: string }> {
  const session = new SearchSession(reader, query, ctx);
  const found: string[] = [];
  const status = await session.run(5e6, 1e6, (r) => found.push(r.text));
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
