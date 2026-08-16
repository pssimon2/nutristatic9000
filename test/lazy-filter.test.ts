// The lazy conjunct path (parseExprBox + makeFilter) must behave exactly
// like the materialized path (parseExpr + ExprFilter) — verified on the
// upstream golden cases — and must additionally handle patterns whose eager
// product compilation is intractable.

import { describe, expect, it } from "vitest";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { BufferSink, IndexWriter, writeEntries } from "../src/index-writer.js";
import { Box, parseExprBox } from "../src/expr-parse.js";
import { makeFilter } from "../src/expr-filter.js";
import { SearchDriver } from "../src/search-driver.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

async function lazySearch(
  expr: string,
  entries: Array<[string, number]>,
): Promise<string | null> {
  const sink = new BufferSink();
  writeEntries(new IndexWriter(sink), entries.slice());

  const box = new Box();
  const p = parseExprBox(expr, 0, box, false, ctx);
  expect(p, `parse of ${JSON.stringify(expr)}`).toBe(expr.length);

  const reader = await IndexReader.open(new MemorySource(sink.bytes()));
  const filter = makeFilter(box.and);
  const driver = new SearchDriver(reader, filter, filter.startState, 1e-6);
  await driver.next();
  return driver.text;
}

describe("lazy conjunct filter", () => {
  const GOLDEN: Array<[string, string | null, string | null]> = [
    ["foo&bar", null, " "],
    ['"(((((m?o)?c)?h)?i)t?)_(h(a(t(o(ry?)?)?)?)?)?&_{5,}" ', "chitchat ", "itch "],
    [
      '("<(-may)?(-sit)?(tit)?(ble)?(com)?(iks)?(ial)?(im-b)?(-mon)?>"&_{18}) ',
      "mayim bialiks sitcom ",
      "mayim bialiks common ",
    ],
    [
      "([aehimnprsw]*&_*a_*e_*&_*h_*&_*i_*&_*m_*&_*n_*&_*p_*&_*r_*&_*s_*&_*w_*) ",
      "new hampshire ",
      "minesweeper ship ",
    ],
    ["<eelqsuuu> ", "equuleus ", "equus "],
    [
      "(c?h?a?r?m?&____)(e?l?t?o?n?&____)(c?h?e?s?t?&____)(o?n?e?&__) ",
      "charlton heston ",
      "charmton heston ",
    ],
    [
      "(<(cerb)?(ecto)?(lonm)?(ddog)?(fblo)?(iero)?(skey)?(ells)?(dwhi)?(atra)?(subj)?(odan)?(thel)?>&_{24}) ",
      "subject of blood and whiskey ",
      "subject of blood and whisubj ",
    ],
    ['"<(cs)(dy)(er)(i)(mo)(n)(th)(__?)>" ', "thermodynamics ", "thermodyanmics "],
    ["(<waterhegm>&_*w_*a_*t_*e_*r_*) ", "wheat germ ", "merge what "],
    [
      "<het><ral><seg><tan><rut><bla><oody><afl><ndi><cin><awe><ter> ",
      "the largest natural body of land in ice water ",
      "the largest natural body of water in iceland ",
    ],
  ];

  for (const [expr, yes, no] of GOLDEN) {
    it(`matches the golden result for ${expr.slice(0, 40)}`, async () => {
      const entries: Array<[string, number]> = [];
      if (yes !== null) entries.push([yes, 1]);
      if (no !== null) entries.push([no, 1]);
      expect(await lazySearch(expr, entries)).toBe(yes);
    }, 60000);
  }

  it("handles an anagram far beyond eager compilation", async () => {
    // 21 distinct letters: the eager product would need on the order of 2^21
    // subset states; lazily, only states along index paths materialize.
    // Uses compileQuery (the app path): its appended trailing space is
    // fixed-length and distributes over the conjuncts. An explicit trailing
    // space IN the pattern would instead fall back to eager materialization.
    const { compileQuery, makeDriver } = await import("../src/find-expr.js");
    const letters = "abcdefghijklmnopqrstu";
    const shuffled = "bacdefghijklmnopqrstu";
    const sink = new BufferSink();
    writeEntries(new IndexWriter(sink), [
      [shuffled + " ", 1],
      [letters.slice(0, 20) + "v ", 1],
    ]);
    const reader = await IndexReader.open(new MemorySource(sink.bytes()));

    for (const query of [`<${letters}>`, `(<${letters}>&_{21})`]) {
      const t0 = performance.now();
      const driver = makeDriver(reader, compileQuery(query, ctx));
      await driver.next();
      const ms = performance.now() - t0;
      expect(driver.text, query).toBe(shuffled + " ");
      expect(ms, `${query} took ${ms}ms`).toBeLessThan(5000);
    }
  }, 30000);

  it("empty intersection terminates immediately", async () => {
    expect(await lazySearch("foo&bar", [[" ", 1]])).toBeNull();
  });
});
