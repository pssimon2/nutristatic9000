// The byte-format contract, against bytes this project did not write.
//
// The index format is byte-compatible with Nutrimatic, forever.
// Nothing tested it. `index-format.test.ts` runs this repo's writer
// into this repo's reader and asserts decoded *meaning*, which a coordinated
// writer-and-reader bug passes green; `fixtures.test.ts` locks results over
// `demo.index`, which this repo also produced. There was no Nutrimatic-generated
// index checked in anywhere, so the headline promise of the project was the one
// thing with no test behind it.
//
// These fixtures were produced by Nutrimatic's own C++ `make-index`, and
// `.dump` by Nutrimatic's own `dump-index`, so the expected meaning is stated by
// Nutrimatic rather than transcribed by me:
//
//   nutrimatic-tiny.index    126 bytes, 9 chains, from nutrimatic-tiny.txt
//   nutrimatic-bigger.index  43 KB, 4,429 chains, counts to 376 — past a byte,
//                          so the count varints are exercised too
//
// Two directions, and the second is the one that closes the hole:
//
//   reading — our IndexReader decodes Nutrimatic's bytes to what Nutrimatic's
//             dumper says is in them.
//   writing — our IndexWriter, given those same chains, produces Nutrimatic's
//             bytes back, byte for byte. A writer-and-reader pair that agreed
//             with each other and not with Nutrimatic would fail this: the input
//             is Nutrimatic's file and the expected output is that same file.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { IndexWalker } from "../src/index-walker.js";
import { BufferSink, IndexWriter } from "../src/index-writer.js";

const FIXTURES = [
  { name: "nutrimatic-tiny", chains: 9 },
  { name: "nutrimatic-bigger", chains: 4429 },
] as const;

/** What Nutrimatic's `dump-index` says is in the file: "  count [text ]". */
function upstreamDump(name: string): Array<{ text: string; count: number }> {
  const lines = fs
    .readFileSync(`test/fixtures/${name}.dump`, "utf8")
    .split("\n")
    .filter((l) => l !== "");
  return lines.map((line) => {
    const m = /^\s*(\d+)\s\[(.*)\]$/.exec(line);
    if (!m) throw new Error(`unparsed dump line: ${JSON.stringify(line)}`);
    return { count: Number(m[1]), text: m[2] };
  });
}

/** Every chain our reader finds, in the order it walks them. */
async function ourEntries(
  name: string,
): Promise<Array<{ text: string; count: number }>> {
  const data = fs.readFileSync(`test/fixtures/${name}.index`);
  const reader = await IndexReader.open(new MemorySource(data));
  const walker = await IndexWalker.create(reader, reader.root(), reader.count());
  const out: Array<{ text: string; count: number }> = [];
  while (walker.text !== null) {
    out.push({ text: walker.text, count: walker.count });
    await walker.next();
  }
  return out;
}

describe("reading an index this project did not write", () => {
  for (const { name, chains } of FIXTURES) {
    it(`decodes ${name} to what Nutrimatic's dumper reports`, async () => {
      const expected = upstreamDump(name);
      // Guards the comparison: an empty dump would make it vacuous.
      expect(expected.length, `${name}.dump is empty`).toBe(chains);
      const ours = await ourEntries(name);
      expect(ours).toEqual(expected);
    }, 60000);
  }

  it("reads the tiny fixture's actual words", async () => {
    // Stated once in full, so a reader of this file can see what the contract
    // is about rather than only that two files agree. From "the quick brown
    // fox / the lazy dog / the quick dog", windowed into chains.
    const ours = await ourEntries("nutrimatic-tiny");
    expect(ours).toEqual([
      { text: "brown fox ", count: 1 },
      { text: "dog ", count: 2 },
      { text: "fox ", count: 1 },
      { text: "lazy dog ", count: 1 },
      { text: "quick brown fox ", count: 1 },
      { text: "quick dog ", count: 1 },
      { text: "the lazy dog ", count: 1 },
      { text: "the quick brown fox ", count: 1 },
      { text: "the quick dog ", count: 1 },
    ]);
  });
});

describe("writing the same bytes back", () => {
  for (const { name } of FIXTURES) {
    it(`re-encodes ${name} byte for byte`, async () => {
      const original = fs.readFileSync(`test/fixtures/${name}.index`);
      const entries = await ourEntries(name);

      const sink = new BufferSink();
      const writer = new IndexWriter(sink);
      // `same` is the common prefix with the previous chain, which is what
      // Nutrimatic's make-index passes and what lets the writer keep one path
      // in memory instead of the whole trie.
      let previous = "";
      for (const { text, count } of entries) {
        let same = 0;
        while (
          same < previous.length &&
          same < text.length &&
          previous[same] === text[same]
        ) {
          ++same;
        }
        writer.next(text, same, count);
        previous = text;
      }
      writer.next(null, 0, 0);

      const ours = sink.bytes();
      expect(ours.length, `${name}: byte length`).toBe(original.length);
      // Compared as arrays so a mismatch reports where, not just that.
      expect([...ours]).toEqual([...original]);
    }, 60000);
  }
});
