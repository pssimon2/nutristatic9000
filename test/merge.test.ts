// Coverage for the k-way merge + frequency cutoff (src/merge.ts) and the
// ParseCache count guard in the reader — previously untested logic.

import { describe, expect, it } from "vitest";
import { MemorySource } from "../src/byte-source.js";
import { Choice, IndexReader } from "../src/index-reader.js";
import { IndexWalker } from "../src/index-walker.js";
import { BufferSink, IndexWriter, writeEntries } from "../src/index-writer.js";
import { mergeWalkers } from "../src/merge.js";

async function buildReader(entries: Array<[string, number]>) {
  const sink = new BufferSink();
  writeEntries(new IndexWriter(sink), entries.slice());
  return IndexReader.open(new MemorySource(sink.bytes()));
}

async function dumpAll(reader: IndexReader): Promise<Array<[string, number]>> {
  const walker = await IndexWalker.create(reader, reader.root(), reader.count());
  const out: Array<[string, number]> = [];
  while (walker.text !== null) {
    out.push([walker.text, walker.count]);
    await walker.next();
  }
  return out;
}

async function merge(
  inputs: Array<Array<[string, number]>>,
  cutoff: number,
): Promise<IndexReader> {
  const walkers = [];
  for (const entries of inputs) {
    const reader = await buildReader(entries);
    walkers.push(await IndexWalker.create(reader, reader.root(), reader.count()));
  }
  const sink = new BufferSink();
  await mergeWalkers(walkers, cutoff, new IndexWriter(sink));
  return IndexReader.open(new MemorySource(sink.bytes()));
}

describe("mergeWalkers", () => {
  it("cutoff 1 equals the accumulated union of the inputs", async () => {
    const merged = await merge(
      [
        [
          ["bar ", 3],
          ["foo ", 7],
          ["foo bar ", 2],
        ],
        [
          ["baz ", 1],
          ["foo ", 4],
        ],
      ],
      1,
    );
    expect(await dumpAll(merged)).toEqual([
      ["bar ", 3],
      ["baz ", 1],
      ["foo ", 11],
      ["foo bar ", 2],
    ]);
    expect(merged.count()).toBe(17);
  });

  it("folds below-cutoff phrases into their word-boundary prefix", async () => {
    // Suffix-closed input (as real make-index output always is: every
    // word-boundary suffix of a phrase is itself indexed). Expectation
    // verified byte-identical against Nutrimatic merge-indexes with cutoff 3:
    // "foo bar " (2 < 3) folds into "foo " (7+2=9), "bar " (2 < 3) drops.
    const merged = await merge(
      [
        [
          ["bar ", 2],
          ["foo ", 7],
          ["foo bar ", 2],
        ],
      ],
      3,
    );
    expect(await dumpAll(merged)).toEqual([["foo ", 9]]);
    expect(merged.count()).toBe(9);
  });

  it("applies the cutoff to the summed count across inputs", async () => {
    const one: Array<[string, number]> = [["x ", 2]];
    const merged = await merge([one, one, one], 5);
    // 2 per input is below the cutoff, but the merged 6 is not.
    expect(await dumpAll(merged)).toEqual([["x ", 6]]);
  });
});

describe("ParseCache", () => {
  it("does not serve a cached parse for a different parent count", async () => {
    // "ab " parses as a chain: the 'b' node's children inherit the count
    // passed in, so the same parent queried with two counts must differ.
    const reader = await buildReader([["ab ", 7]]);
    const top: Choice[] = [];
    await reader.children(reader.root(), reader.count(), top);
    const aNode = top.find((c) => c.ch === "a".charCodeAt(0))!;
    expect(aNode.count).toBe(7);

    const first: Choice[] = [];
    await reader.children(aNode.next, 7, first);
    expect(first.map((c) => c.count)).toEqual([7]);

    const second: Choice[] = [];
    await reader.children(aNode.next, 5, second);
    expect(second.map((c) => c.count)).toEqual([5]);
  });
});
