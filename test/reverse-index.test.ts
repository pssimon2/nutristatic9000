// The reverse-index sidecar: searching it returns the same strings at
// the same scores as the forward index, spelled backwards — including phrase
// counts, which a naive per-entry reversal gets wrong at window boundaries.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SessionContext } from "../src/session-context.js";
import { compileQuery, makeDriver } from "../src/find-expr.js";
import { makeFilter } from "../src/expr-filter.js";
import { BufferSink } from "../src/index-writer.js";
import {
  buildReverseIndex,
  compileConjunctsReversed,
  reverseFavored,
  unreverseText,
} from "../src/reverse.js";

const ctx = new SessionContext();

async function open(file: string): Promise<IndexReader> {
  return IndexReader.open(new MemorySource(fs.readFileSync(file)));
}

async function collect(
  step: () => boolean | Promise<boolean>,
  text: () => string | null,
  score: () => number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < 500000; ++i) {
    let r = step();
    if (r instanceof Promise) r = await r;
    if (r) {
      const t = text();
      if (t === null) break;
      out.set(t.replace(/ +$/, ""), score());
    }
  }
  return out;
}

async function forwardAndReversed(query: string) {
  const reader = await open("test/fixtures/upstream-tiny.index");
  const sink = new BufferSink();
  await buildReverseIndex(reader, sink);
  const revReader = await IndexReader.open(new MemorySource(sink.bytes()));

  const fwd = makeDriver(reader, compileQuery(query, ctx));
  const forward = await collect(
    () => fwd.step(),
    () => fwd.text,
    () => fwd.score,
  );

  const rev = makeDriver(revReader, makeFilter(compileConjunctsReversed(query, ctx)));
  const reversed = await collect(
    () => rev.step(),
    () => (rev.text === null ? null : unreverseText(rev.text)),
    () => rev.score,
  );
  return { forward, reversed };
}

describe("the reverse index", () => {
  it("answers single words identically", async () => {
    const { forward, reversed } = await forwardAndReversed('"A{1,9}"');
    expect(reversed).toEqual(forward);
  });

  it("answers phrases identically — the window-boundary counts", async () => {
    const { forward, reversed } = await forwardAndReversed('"A{3,5} A{3,5}"');
    expect(reversed).toEqual(forward);
  });

  it("answers a suffix-anchored pattern identically", async () => {
    // `…x` is the pattern class the sidecar exists for: forward, the trie
    // cannot prune until the last letter; reversed, the anchor is a prefix.
    const { forward, reversed } = await forwardAndReversed('"A{1,8}x"');
    expect(reversed).toEqual(forward);
    expect(forward.size).toBeGreaterThan(0); // fox is in there
  });
});

describe("reverseFavored", () => {
  it("prefers the sidecar exactly when the suffix pins more than the prefix", () => {
    expect(reverseFavored('"A{1,8}x"', ctx)).toBe(true); // .*x-shaped
    expect(reverseFavored('"xA{1,8}"', ctx)).toBe(false); // prefix-anchored
    expect(reverseFavored("A{5}", ctx)).toBe(false); // symmetric
  });

  it("declines what cannot reverse, and lets the forward path report it", () => {
    expect(reverseFavored("{~list:alpha,beta}", ctx)).toBe(false); // weighted
    expect(reverseFavored("A{5", ctx)).toBe(false); // does not parse
  });
});
