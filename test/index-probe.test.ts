// Asking the index about one string.
//
// The probe and the search have to agree about what a word is, or the
// constructs built on it drift from the results beside them. That agreement is
// what most of this file checks: the probe's answer for a string is the score
// the search reports for the same string.

import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";
import { probeCount, probeShare } from "../src/index-probe.js";

let reader: IndexReader;
const ctx = new SessionContext();

beforeAll(async () => {
  reader = await IndexReader.open(
    new MemorySource(fs.readFileSync("web/public/demo.index")),
  );
});

/** What the search says about an exact string, for comparison. */
async function searchScore(text: string): Promise<number | null> {
  const session = new SearchSession(reader, `"${text}"`, ctx);
  let found: number | null = null;
  await session.run(1e6, 5, (r) => {
    if (r.text === text && found === null) found = r.score;
  });
  return found;
}

describe("the probe agrees with the search", () => {
  for (const word of ["the", "chicken", "solar system", "blasphemer"]) {
    it(`gives the same score for "${word}" as searching for it`, async () => {
      const probed = await probeCount(reader, word);
      expect(probed, `${word} not found by the probe`).toBeGreaterThan(0);
      const searched = await searchScore(word);
      expect(searched, `${word} not found by the search`).not.toBeNull();
      // Relative: these run from millions down to single figures.
      expect(Math.abs(probed - (searched as number)) / probed).toBeLessThan(1e-9);
    }, 60000);
  }
});

describe("what counts as a word", () => {
  it("counts the whole word, not every word starting with it", async () => {
    // The trailing space is the point: without it "car" would also be
    // counting CARTOON and CARRY, which is how {compound …} came to accept
    // fragments before the boundary was required.
    const car = await probeCount(reader, "car");
    const cartoon = await probeCount(reader, "cartoon");
    expect(car).toBeGreaterThan(0);
    expect(cartoon).toBeGreaterThan(0);
    // If the probe were counting prefixes, "car" would include "cartoon" and
    // the trie's own subtree count would be far larger than the word's.
    expect(car).toBeLessThan(await prefixSubtreeCount("car"));
  });

  /** Occurrences under the "car" subtree — every word beginning with it. */
  async function prefixSubtreeCount(prefix: string): Promise<number> {
    let node = reader.root();
    let count = reader.count();
    const out: Array<{ ch: number; count: number; next: number }> = [];
    for (const ch of prefix) {
      out.length = 0;
      const r = reader.children(node, count, out);
      if (r instanceof Promise) await r;
      const child = out.find((c) => c.ch === ch.charCodeAt(0));
      if (!child) return 0;
      node = child.next;
      count = child.count;
    }
    return count;
  }
});

describe("strings the index does not have", () => {
  it("returns zero rather than throwing", async () => {
    expect(await probeCount(reader, "qqzzxxjjv")).toBe(0);
    expect(await probeCount(reader, "")).toBe(0);
    expect(await probeCount(reader, "the qqzzxxjjv")).toBe(0);
  });

  it("returns zero for a share too", async () => {
    expect(await probeShare(reader, "qqzzxxjjv")).toBe(0);
  });
});

describe("shares", () => {
  it("reports a fraction of the corpus", async () => {
    const share = await probeShare(reader, "the");
    // "the" is the commonest word in this corpus but not most of it.
    expect(share).toBeGreaterThan(1e-3);
    expect(share).toBeLessThan(1);
  });

  it("orders words the way frequency does", async () => {
    const the = await probeShare(reader, "the");
    const chicken = await probeShare(reader, "chicken");
    const rare = await probeShare(reader, "blasphemer");
    expect(the).toBeGreaterThan(chicken);
    expect(chicken).toBeGreaterThan(rare);
    expect(rare).toBeGreaterThan(0);
  });

  it("is the count over the corpus total", async () => {
    const count = await probeCount(reader, "chicken");
    expect(await probeShare(reader, "chicken")).toBeCloseTo(
      count / reader.count(),
      12,
    );
  });
});
