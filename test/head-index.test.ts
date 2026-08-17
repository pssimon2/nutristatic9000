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
  headWordChecker,
  parseHeadIndex,
  searchHeadIndex,
} from "../src/head-index.js";
import { parseFilterWrappers } from "../src/result-filter.js";
import { probeCount } from "../src/index-probe.js";
import {
  COMPOUND_PIECE_FLOOR,
  REVERSAL_FLOOR,
  makeWordChecker,
} from "../src/index-words.js";

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

// The head answering the word question itself.
//
// This is the claim that makes it sound: the floors are shares of the corpus,
// the head is sorted by exactly that quantity, so once the head reaches below
// a floor, absence from the head *is* failure of the floor. If that ever
// stopped holding the two constructs would silently start losing answers.
describe("the head as the word oracle", () => {
  const total = 1e6;
  // Read inside the tests: the head is built in beforeAll, after collection.
  const lowest = () => head.score[head.score.length - 1];

  it("only claims to answer down to where it reaches", () => {
    // The precondition, as arithmetic. This 60,000-entry head, built from the
    // demo index, happens to straddle the two floors — deep enough to settle a
    // compound piece, not deep enough for a reversal — which is what lets both
    // branches below be tested with the real constants. A head the site
    // actually ships covers both; scripts/build-head.mjs checks that.
    expect(lowest()).toBeLessThan(COMPOUND_PIECE_FLOOR * reader.count());
    expect(lowest()).toBeGreaterThan(REVERSAL_FLOOR * reader.count());
  });

  it("never accepts a word the index would reject", async () => {
    const fromIndex = makeWordChecker(reader);
    const fromHead = headWordChecker(head, reader.count(), () => {
      throw new Error("fell back: the head should have answered this");
    });
    // A mix of common words, corpus debris, and things that are not there.
    const words = [
      ...head.text.filter((t) => !t.includes(" ")).slice(0, 300),
      ...head.text.slice(-400).map((t) => t.split(" ")[0]),
      "avai", "lable", "taht", "eht", "morf", "qqzzxx", "",
    ];
    let accepted = 0;
    for (const w of words) {
      const here = await fromHead(w, COMPOUND_PIECE_FLOOR);
      // One-directional: the head is the index's frequency test plus the
      // suffix test, so it may reject more, never accept more.
      if (here) {
        expect(await fromIndex(w, COMPOUND_PIECE_FLOOR), w).toBe(true);
        ++accepted;
      }
    }
    // A checker that said "no" to everything would satisfy the implication
    // above vacuously; this makes sure there was a real signal.
    expect(accepted, "nothing was accepted, so nothing was compared")
      .toBeGreaterThan(50);
  }, 120000);

  it("rejects a suffix the frequency floor lets through", async () => {
    const fromIndex = makeWordChecker(reader);
    const fromHead = headWordChecker(head, reader.count(), () => false);
    // The whole point: these clear the floor — the index calls them words —
    // and are not words. Only asserted for the ones this corpus actually
    // carries, since the demo index is a web crawl, not the deployed one.
    let checked = 0;
    for (const suffix of ["ed", "ing", "ment", "ness", "tion", "sh", "al"]) {
      if (!(await fromIndex(suffix, COMPOUND_PIECE_FLOOR))) continue;
      ++checked;
      expect(await fromHead(suffix, COMPOUND_PIECE_FLOOR), suffix).toBe(false);
    }
    expect(checked, "no suffix in this corpus cleared the floor")
      .toBeGreaterThan(2);
  }, 120000);

  it("keeps the short words a floor alone cannot tell from a suffix", async () => {
    const fromIndex = makeWordChecker(reader);
    const fromHead = headWordChecker(head, reader.count(), () => false);
    // The cost side of the same threshold: real pieces must survive it.
    let checked = 0;
    for (const word of ["box", "book", "some", "thing", "copy", "keep", "up"]) {
      if (!(await fromIndex(word, COMPOUND_PIECE_FLOOR))) continue;
      ++checked;
      expect(await fromHead(word, COMPOUND_PIECE_FLOOR), word).toBe(true);
    }
    expect(checked, "none of these cleared the floor").toBeGreaterThan(2);
  }, 120000);

  it("hands back a floor it does not reach rather than guessing", async () => {
    const asked: string[] = [];
    const fromHead = headWordChecker(head, reader.count(), (w) => {
      asked.push(w);
      return true;
    });
    // Below the head's last score: absence from the head proves nothing here.
    expect(await fromHead("qqzzxx", REVERSAL_FLOOR)).toBe(true);
    expect(asked).toEqual(["qqzzxx"]);
  });

  it("hands back plain presence, which it can never settle", async () => {
    let asked = "";
    const fromHead = headWordChecker(head, total, (w) => {
      asked = w;
      return true;
    });
    // minShare 0 means "is it in the index at all", and the head holds only
    // the top of it, so absence is never an answer.
    expect(await fromHead("qqzzxx", 0)).toBe(true);
    expect(asked).toBe("qqzzxx");
  });

  it("does not treat a phrase as a word", () => {
    const phrase = head.text.find((t) => t.includes(" "));
    expect(phrase, "no phrase in the head to check").toBeDefined();
    const fromHead = headWordChecker(head, reader.count(), () => false);
    expect(fromHead(phrase as string, REVERSAL_FLOOR)).toBe(false);
  });
});

// A head belongs to one index, and only that one.
//
// The site serves the head *as* the first page of a search and never touches
// the index on that path — so a head left behind by an index rebuild goes on
// answering with entries the index no longer has, at scores it no longer has,
// with nothing able to notice. scripts/check-head.mjs is the guard; this is
// the property it checks.
describe("a head matches the index it was built from", () => {
  it("has every entry, at the score the index gives it", async () => {
    // A spread rather than all 60,000: the point is to catch a mismatched
    // pair, which shows in the first handful.
    const at = [0, 1, 2, 3, 10, 100, 1000, 10000, head.text.length - 1];
    for (const i of at) {
      const text = head.text[i];
      const count = await probeCount(reader, text);
      expect(count, `${JSON.stringify(text)} at ${i} is not in the index`)
        .toBeGreaterThan(0);
      // Five significant digits, so relative — see the note at the top.
      expect(
        Math.abs(count - head.score[i]) / count,
        `${text}: head ${head.score[i]} vs index ${count}`,
      ).toBeLessThan(1e-4);
    }
  }, 60000);

  it("would not match an index it was not built from", async () => {
    // The failure the guard exists for, made concrete: an entry no index of
    // this corpus contains has to come back as absent, not as zero-ish.
    expect(await probeCount(reader, "qqzzxxjjv")).toBe(0);
    // And a score from a different corpus disagrees by orders of magnitude,
    // not by rounding — which is why the comparison is relative and tight.
    const theirs = 1.2343e8; // "and" in the English Wikipedia head
    const ours = await probeCount(reader, "and");
    expect(Math.abs(ours - theirs) / ours).toBeGreaterThan(1e-4);
  }, 60000);
});
