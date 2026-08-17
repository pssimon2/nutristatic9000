// The head of the index must answer exactly as the index does.
//
// The whole point of the sidecar is that it is not a guess: it is the prefix
// of what the same best-first search emits, so serving it as the first page of
// a search has to give the same answers, in the same order, with the same
// scores. If it did not, a reader would get different results depending on
// whether the sidecar happened to be fetched — which is worse than not having
// one.

import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { SearchSession } from "../src/search-session.js";
import { SessionContext } from "../src/session-context.js";
import { compileQuery } from "../src/find-expr.js";
import {
  type HeadIndex,
  headPage,
  parseHeadIndex,
  searchHeadIndex,
} from "../src/head-index.js";
import { parseFilterWrappers } from "../src/result-filter.js";

const ctx = new SessionContext();
let reader: IndexReader;
let head: HeadIndex;

beforeAll(async () => {
  const data = fs.readFileSync("web/public/demo.index");
  reader = await IndexReader.open(new MemorySource(data));
  // Built here rather than committed: it is derived from the index beside it,
  // and a stale copy would test the wrong thing.
  const session = new SearchSession(reader, ".*", ctx);
  const lines: string[] = [];
  await session.run(2e7, 60000, (r) =>
    lines.push(`${r.text}\t${r.score.toExponential(4)}`),
  );
  head = parseHeadIndex(lines.join("\n"));
}, 120000);

async function fromIndex(query: string, limit: number) {
  const session = new SearchSession(reader, query, ctx);
  const out: Array<{ text: string; score: number }> = [];
  await session.run(5e6, limit, (r) => out.push({ text: r.text, score: r.score }));
  return out;
}

describe("the head is the index's own prefix", () => {
  it("holds the entries the search emits first, in that order", () => {
    expect(head.text.length).toBe(60000);
    expect(head.text[0]).toBe("the");
    for (let i = 1; i < head.score.length; ++i) {
      expect(head.score[i]).toBeLessThanOrEqual(head.score[i - 1]);
    }
  });

  for (const query of [
    "A{5}",
    "A{5}&C*",
    "{distinct:A{6}}",
    "{sum=52:A*}",
    '"C*aC*eC*i"',
    "A{4} A{5}",
  ]) {
    it(`answers ${query} as the index does`, async () => {
      const filter = compileQuery(query, ctx);
      const fromHead = searchHeadIndex(head, filter, 25);
      expect(fromHead.length, "nothing to compare").toBeGreaterThan(0);
      const fromIdx = await fromIndex(query, fromHead.length);
      // Same answers in the same order.
      expect(fromHead.map((r) => r.text)).toEqual(fromIdx.map((r) => r.text));
      // Same scores to the precision the file keeps: five significant digits,
      // which is one more than the page ever shows. Storing them exactly would
      // add about a megabyte over the wire to change nothing a reader sees.
      // Relative, not absolute: these scores run from 1e10 down to 1e-9, so
      // "close to five decimal places" would mean nothing at either end.
      for (let i = 0; i < fromHead.length; ++i) {
        expect(
          Math.abs(fromHead[i].score - fromIdx[i].score) / fromIdx[i].score,
          `${fromHead[i].text}: ${fromHead[i].score} vs ${fromIdx[i].score}`,
        ).toBeLessThan(1e-4);
      }
    }, 60000);
  }
});

describe("where the head runs out", () => {
  it("stops at its own end rather than inventing anything", () => {
    // A pattern whose answers are all rarer than the head reaches: it must
    // return nothing, not a near miss.
    const filter = compileQuery('"qqzzxxjjv"', ctx);
    expect(searchHeadIndex(head, filter, 10)).toEqual([]);
  });

  it("returns a prefix of the index's answers, never more", async () => {
    const filter = compileQuery("A{5}&C*", ctx);
    const fromHead = searchHeadIndex(head, filter, 100000);
    const fromIdx = await fromIndex("A{5}&C*", 100000);
    expect(fromHead.length).toBeLessThanOrEqual(fromIdx.length);
    expect(fromHead.map((r) => r.text)).toEqual(
      fromIdx.slice(0, fromHead.length).map((r) => r.text),
    );
  }, 60000);
});

describe("parsing", () => {
  it("ignores blank and malformed lines rather than throwing", () => {
    const parsed = parseHeadIndex("a\t1e-3\n\nbroken\nb\tnot-a-number\nc\t2e-4\n");
    expect(parsed.text).toEqual(["a", "c"]);
    expect([...parsed.score]).toEqual([1e-3, 2e-4]);
  });

  it("keeps entries containing spaces whole", () => {
    const parsed = parseHeadIndex("solar system\t5e-6\n");
    expect(parsed.text).toEqual(["solar system"]);
  });
});

// The head answers the automaton half of a query. Anything checked on a
// finished match still has to be applied afterwards — and was not, at first:
// `{palindrome:A{5}}` served "of the", which is not a palindrome, because the
// head path skipped the step the index path does in `flushPending`.
describe("predicates on head results", () => {
  const isWord = (w: string) => head.text.includes(w);

  async function page(query: string, limit: number) {
    const { specs, inner } = parseFilterWrappers(query);
    const out = await headPage(
      head,
      compileQuery(inner, ctx),
      specs,
      ctx,
      isWord as never,
      limit,
    );
    return out.results;
  }

  it("applies the predicate rather than serving candidates", async () => {
    const out = await page("{palindrome:A{5}}", 5);
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) {
      const letters = r.text.replaceAll(" ", "");
      expect([...letters].reverse().join(""), r.text).toBe(letters);
    }
  });

  it("carries the note the predicate produced", async () => {
    const out = await page("{compound 2:A{9}}", 3);
    expect(out.length).toBeGreaterThan(0);
    for (const r of out) expect(r.note, r.text).toMatch(/·/);
  });

  it("reads past the limit to find survivors", async () => {
    // The point of the candidate factor: palindromes are not in the first
    // few entries of anything, so reading only `limit` candidates finds none.
    const { specs, inner } = parseFilterWrappers("{palindrome:A{5}}");
    const filter = compileQuery(inner, ctx);
    const narrow = await headPage(head, filter, specs, ctx, isWord as never, 3, 1);
    const wide = await headPage(head, filter, specs, ctx, isWord as never, 3, 40);
    expect(narrow.results.length).toBe(0);
    expect(wide.results.length).toBeGreaterThan(narrow.results.length);
  });

  it("returns what it found when the predicate rejects the rest", async () => {
    const out = await page("{palindrome:A{5}}", 100000);
    // Fewer than asked, and every one still a palindrome — a short page must
    // not be padded with candidates.
    expect(out.length).toBeLessThan(100000);
    for (const r of out) {
      const letters = r.text.replaceAll(" ", "");
      expect([...letters].reverse().join("")).toBe(letters);
    }
  });

  it("passes plain queries straight through", async () => {
    const out = await page("A{5}", 4);
    expect(out.length).toBe(4);
    for (const r of out) expect(r.note).toBeUndefined();
  });
});

// Paging: the second page must continue where the first stopped, not repeat it.
describe("paging through the head", () => {
  it("resumes after the last entry it served", async () => {
    const filter = compileQuery("A{5}", ctx);
    const first = await headPage(head, filter, [], ctx, (() => false) as never, 5);
    const second = await headPage(
      head, filter, [], ctx, (() => false) as never, 5, 40, first.next,
    );
    expect(first.results.length).toBe(5);
    expect(second.results.length).toBe(5);
    const firstTexts = new Set(first.results.map((r) => r.text));
    for (const r of second.results) expect(firstTexts.has(r.text)).toBe(false);
    // And still in order: page two scores no higher than page one's last.
    expect(second.results[0].score).toBeLessThanOrEqual(
      first.results[first.results.length - 1].score,
    );
  });

  it("reports the end when the head is spent", async () => {
    const filter = compileQuery("A{5}", ctx);
    const out = await headPage(
      head, filter, [], ctx, (() => false) as never, 5, 40, head.text.length,
    );
    expect(out.results).toEqual([]);
    expect(out.next).toBe(head.text.length);
  });
});
