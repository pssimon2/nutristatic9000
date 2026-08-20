// Port of Nutrimatic test-expr.cpp: each case builds a tiny index holding a
// "yes" and a "no" string, then checks the expression finds exactly the
// "yes" string first (and nothing further at an equal-or-better score).

import { describe, expect, it } from "vitest";
import { MemorySource } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { BufferSink, IndexWriter, writeEntries } from "../src/index-writer.js";
import { Nfa } from "../src/automata.js";
import { parseExpr } from "../src/expr-parse.js";
import { ExprFilter } from "../src/expr-filter.js";
import { SearchDriver } from "../src/search-driver.js";
import { SessionContext } from "../src/session-context.js";
import { compileQuery } from "../src/find-expr.js";
import { ParseError } from "../src/parse-error.js";

const ctx = new SessionContext();

async function testIndex(
  expr: string,
  yes: string | null,
  no: string | null,
): Promise<void> {
  const entries: Array<[string, number]> = [];
  if (yes !== null) entries.push([yes, 1]);
  if (no !== null) entries.push([no, 1]);
  const sink = new BufferSink();
  writeEntries(new IndexWriter(sink), entries);

  const parsed = new Nfa();
  const p = parseExpr(expr, 0, parsed, false, ctx);
  expect(p, `parse of ${JSON.stringify(expr)}`).toBe(expr.length);

  const reader = await IndexReader.open(new MemorySource(sink.bytes()));
  const filter = new ExprFilter(parsed);
  const driver = new SearchDriver(reader, filter, filter.startState, 1e-6);
  await driver.next();

  if (yes === null) {
    expect(driver.text, `[${expr}] expected no results`).toBeNull();
    return;
  }

  expect(driver.text, `[${expr}] expected "${yes}"`).toBe(yes);

  const score = driver.score;
  await driver.next();
  if (driver.text !== null) {
    expect(
      driver.score,
      `[${expr}] unexpected extra result "${driver.text}"`,
    ).toBeLessThan(score);
  }
}

describe("test-expr golden cases (from Nutrimatic test-expr.cpp)", () => {
  it("intersection with no possible match", async () => {
    await testIndex("foo&bar", null, " ");
  });

  it("nested optional groups with intersection", async () => {
    await testIndex(
      '"(((((m?o)?c)?h)?i)t?)_(h(a(t(o(ry?)?)?)?)?)?&_{5,}" ',
      "chitchat ",
      "itch ",
    );
  });

  it("quoted anagram of optional multi-char parts", async () => {
    await testIndex(
      '("<(-may)?(-sit)?(tit)?(ble)?(com)?(iks)?(ial)?(im-b)?(-mon)?>"&_{18}) ',
      "mayim bialiks sitcom ",
      "mayim bialiks common ",
    );
  }, 60000);

  it("letter-bank intersection", async () => {
    await testIndex(
      "([aehimnprsw]*&_*a_*e_*&_*h_*&_*i_*&_*m_*&_*n_*&_*p_*&_*r_*&_*s_*&_*w_*) ",
      "new hampshire ",
      "minesweeper ship ",
    );
  });

  it("simple letter anagram", async () => {
    await testIndex("<eelqsuuu> ", "equuleus ", "equus ");
  });

  it("chained optional-letter banks", async () => {
    await testIndex(
      "(c?h?a?r?m?&____)(e?l?t?o?n?&____)(c?h?e?s?t?&____)(o?n?e?&__) ",
      "charlton heston ",
      "charmton heston ",
    );
  });

  it("large anagram of 4-char groups with length constraint", async () => {
    await testIndex(
      "(<(cerb)?(ecto)?(lonm)?(ddog)?(fblo)?(iero)?(skey)?(ells)?(dwhi)?(atra)?(subj)?(odan)?(thel)?>&_{24}) ",
      "subject of blood and whiskey ",
      "subject of blood and whisubj ",
    );
  }, 60000);

  it("quoted anagram with wildcard part", async () => {
    await testIndex(
      '"<(cs)(dy)(er)(i)(mo)(n)(th)(__?)>" ',
      "thermodynamics ",
      "thermodyanmics ",
    );
  });

  it("anagram intersected with ordered letters", async () => {
    await testIndex(
      "(<waterhegm>&_*w_*a_*t_*e_*r_*) ",
      "wheat germ ",
      "merge what ",
    );
  });

  it("many-part anagram phrase", async () => {
    await testIndex(
      "<het><ral><seg><tan><rut><bla><oody><afl><ndi><cin><awe><ter> ",
      "the largest natural body of land in ice water ",
      "the largest natural body of water in iceland ",
    );
  }, 120000);

  it("reads a hyphen at either end of a class as a member, not a range", async () => {
    await testIndex('"[-abc]" ', "a ", "d ");
    await testIndex('"[abc-]" ', "b ", "d ");
  });

  it("still reads an interior hyphen as a range", async () => {
    await testIndex('"[a-c]" ', "b ", "d ");
  });

  it("refuses an inverted or unclosed range", async () => {
    expect(() => compileQuery("[z-a]", new SessionContext())).toThrow(ParseError);
    expect(() => compileQuery("[a-", new SessionContext())).toThrow(ParseError);
  });
});
