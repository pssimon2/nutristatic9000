// Multi-index merged search: one query, several corpora, one stream in
// normalized score order, duplicates collapsed to their best reading.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SessionContext } from "../src/session-context.js";
import { compileQuery } from "../src/find-expr.js";
import { MergedDriver } from "../src/merged-driver.js";

const ctx = new SessionContext();

async function open(file: string): Promise<IndexReader> {
  return IndexReader.open(new MemorySource(fs.readFileSync(file)));
}

async function runMerged(query: string, max = 200) {
  const tiny = await open("test/fixtures/nutrimatic-tiny.index");
  const bigger = await open("test/fixtures/nutrimatic-bigger.index");
  const driver = new MergedDriver(
    [
      { reader: tiny, label: "tiny" },
      { reader: bigger, label: "bigger" },
    ],
    compileQuery(query, ctx),
  );
  const out: Array<{ text: string; score: number; source: string }> = [];
  for (let steps = 0; steps < 500000 && out.length < max; ++steps) {
    let r = driver.step();
    if (r instanceof Promise) r = await r;
    if (r) {
      if (driver.text === null) break;
      out.push({
        text: driver.text.replace(/ +$/, ""),
        score: driver.score,
        source: driver.source,
      });
    }
  }
  return out;
}

describe("MergedDriver", () => {
  it("merges both corpora in descending normalized order, deduplicated", async () => {
    const results = await runMerged("A*");
    expect(results.length).toBeGreaterThan(20);
    for (let i = 1; i < results.length; ++i) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
    const sources = new Set(results.map((r) => r.source));
    expect(sources).toEqual(new Set(["tiny", "bigger"]));
    const texts = results.map((r) => r.text);
    expect(new Set(texts).size).toBe(texts.length);
    // A word in both corpora ("dog") appears once, from the corpus where it
    // is relatively commonest — the tiny one.
    expect(results.find((r) => r.text === "dog")?.source).toBe("tiny");
    // A word only the bigger corpus has still arrives.
    expect(results.some((r) => r.text === "alpha" && r.source === "bigger")).toBe(true);
  });

  it("reports exhaustion once every lane is spent", async () => {
    const tiny = await open("test/fixtures/nutrimatic-tiny.index");
    const driver = new MergedDriver(
      [{ reader: tiny, label: "tiny" }],
      compileQuery("fox", ctx),
    );
    const seen: string[] = [];
    let exhausted = false;
    for (let steps = 0; steps < 100000; ++steps) {
      let r = driver.step();
      if (r instanceof Promise) r = await r;
      if (r) {
        if (driver.text === null) {
          exhausted = true;
          break;
        }
        seen.push(driver.text.trim());
      }
    }
    expect(seen).toContain("fox");
    expect(exhausted).toBe(true);
  });
});
