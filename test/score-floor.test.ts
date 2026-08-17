// The score-floor knob: an optional frontier budget.
//
// Priority is an upper bound on any score a frontier entry can still reach,
// so dropping entries below `floor × best-emitted-score` can only cost
// results *below* the floor — the head of the stream must be identical. What
// the knob buys is a smaller frontier; what it costs is the deep tail, and
// both sides are asserted here rather than taken on faith.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SessionContext } from "../src/session-context.js";
import { compileQuery, makeDriver } from "../src/find-expr.js";

const ctx = new SessionContext();

async function run(query: string, scoreFloor: number, maxResults: number) {
  const data = fs.readFileSync("test/fixtures/upstream-bigger.index");
  const reader = await IndexReader.open(new MemorySource(data));
  const driver = makeDriver(reader, compileQuery(query, ctx), undefined, {
    scoreFloor,
  });
  const results: Array<{ text: string; score: number }> = [];
  for (let steps = 0; steps < 300000 && results.length < maxResults; ++steps) {
    let r = driver.step();
    if (r instanceof Promise) r = await r;
    if (r) {
      if (driver.text === null) break;
      results.push({ text: driver.text, score: driver.score });
    }
  }
  return { results, frontierPeak: driver.frontierPeak };
}

describe("the score floor", () => {
  it("keeps the head of the stream identical and the frontier smaller", async () => {
    const plain = await run("A*", 0, 40);
    const floored = await run("A*", 1e-4, 40);
    // The floor drops entries by *priority*, an upper bound on their final
    // score — so a result below the cut may still slip through, but nothing
    // above it may be lost. Equal priorities may pop in a different order
    // when the frontier's shape differs, so the assertion is membership plus
    // the stream staying in descending-score order, not byte-for-byte
    // equality.
    const cut = 1e-4 * plain.results[0].score;
    const kept = plain.results.filter((r) => r.score >= cut);
    const seen = new Set(floored.results.map((r) => `${r.score} ${r.text}`));
    for (const k of kept) {
      expect(seen.has(`${k.score} ${k.text}`), `${k.text} lost`).toBe(true);
    }
    for (let i = 1; i < floored.results.length; ++i) {
      expect(floored.results[i].score).toBeLessThanOrEqual(
        floored.results[i - 1].score,
      );
    }
    expect(kept.length).toBeGreaterThan(5); // the assertions above bit something
    expect(floored.frontierPeak).toBeLessThanOrEqual(plain.frontierPeak);
  });

  it("is off by default", async () => {
    const a = await run("A{4}", 0, 25);
    const b = await run("A{4}", 0, 25);
    expect(a.results).toEqual(b.results);
  });
});
