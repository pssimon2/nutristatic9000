// First-letter sharding: shards are disjoint and complete, including
// the phrases only a restart can reach — the case a naive root filter loses.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SessionContext } from "../src/session-context.js";
import { compileQuery, makeDriver } from "../src/find-expr.js";
import { shardSeedLetters } from "../src/shards.js";

const ctx = new SessionContext();

async function open(file: string): Promise<IndexReader> {
  return IndexReader.open(new MemorySource(fs.readFileSync(file)));
}

async function runAll(
  reader: IndexReader,
  query: string,
  seedLetters?: number[],
): Promise<Map<string, number>> {
  const driver = makeDriver(reader, compileQuery(query, ctx), undefined, {
    ...(seedLetters === undefined ? {} : { seedLetters }),
  });
  const out = new Map<string, number>();
  for (let steps = 0; steps < 500000; ++steps) {
    let r = driver.step();
    if (r instanceof Promise) r = await r;
    if (r) {
      if (driver.text === null) break;
      out.set(driver.text.replace(/ +$/, ""), driver.score);
    }
  }
  return out;
}

describe("shardSeedLetters", () => {
  it("partitions the root's children, disjoint and covering", async () => {
    const reader = await open("test/fixtures/upstream-bigger.index");
    const shards = await shardSeedLetters(reader, 3);
    expect(shards.length).toBe(3);
    const all = shards.flat();
    expect(new Set(all).size).toBe(all.length);
    const full = await shardSeedLetters(reader, 1);
    expect(new Set(all)).toEqual(new Set(full[0]));
  });
});

describe("sharded walks", () => {
  it("union of shards equals the unsharded search, texts and scores", async () => {
    // Quoted, so the language is exhaustible: every run ends by finishing,
    // not by the step budget — an unsharded walk and a shard dig equally
    // deep, and equality is meaningful.
    const reader = await open("test/fixtures/upstream-tiny.index");
    const full = await runAll(reader, '"A{1,9}"');
    const shards = await shardSeedLetters(reader, 2);
    const parts = await Promise.all(
      shards.map((letters) => runAll(reader, '"A{1,9}"', letters)),
    );
    // Disjoint: no result appears in two shards.
    const seen = new Set<string>();
    for (const part of parts) {
      for (const text of part.keys()) {
        expect(seen.has(text), `${text} in two shards`).toBe(false);
        seen.add(text);
      }
    }
    // Complete, and score-identical.
    const union = new Map<string, number>();
    for (const part of parts) for (const [t, s] of part) union.set(t, s);
    expect(union).toEqual(full);
  });

  it("never invents or rescores a result under a shared step budget", async () => {
    // The open-ended form cannot be exhausted, so the claim under a budget
    // is one-sided: everything the full walk found sits in exactly one
    // shard, at the same score (each shard, owning less space, digs at
    // least as deep as the full walk did into it).
    const reader = await open("test/fixtures/upstream-tiny.index");
    const full = await runAll(reader, "A*");
    const shards = await shardSeedLetters(reader, 2);
    const parts = await Promise.all(
      shards.map((letters) => runAll(reader, "A*", letters)),
    );
    for (const [text, score] of full) {
      const holders = parts.filter((p) => p.has(text));
      expect(holders.length, text).toBe(1);
      expect(holders[0].get(text), text).toBe(score);
    }
  });

  it("keeps restart phrases in the shard of their FIRST letter", async () => {
    const reader = await open("test/fixtures/upstream-tiny.index");
    const t = "t".charCodeAt(0);
    const withT = await runAll(reader, "A*", [t]);
    const withoutT = await runAll(
      reader,
      "A*",
      [..."abcdefghijklmnopqrsuvwxyz"].map((c) => c.charCodeAt(0)),
    );
    // "the quick" starts with t: owned by the t-shard even though "quick"
    // does not — this is the phrase a restart builds, and the one a naive
    // every-root-visit filter silently loses.
    expect([...withT.keys()].some((x) => x.startsWith("the "))).toBe(true);
    for (const text of withoutT.keys()) {
      expect(text.startsWith("t"), `${text} leaked into the non-t shard`).toBe(false);
    }
    // And the non-t shard still finds its own multi-word phrases.
    expect([...withoutT.keys()].some((x) => x.includes(" "))).toBe(true);
  });
});
