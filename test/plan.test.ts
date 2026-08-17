// What a query compiles to, described before it runs.
//
// The number that carries the weight is finiteness: a finite conjunct is a set
// the walk can exhaust, an unbounded one is only ever stopped by the step
// budget. Getting it wrong in either direction makes `--explain` worse than
// nothing, so most of these tests are about that judgement.

import { describe, expect, it } from "vitest";
import { formatPlan, languageSize, planQuery } from "../src/plan.js";
import { innerNfa } from "../src/conjunct.js";
import { compileConjuncts } from "../src/find-expr.js";
import { SessionContext } from "../src/session-context.js";
import * as fs from "node:fs";
import { parseCategories } from "../src/categories.js";
import { parsePhonetics } from "../src/phonetics.js";
import { parseWikiLists } from "../src/word-lists.js";

const ctx = new SessionContext();
// The strategy tests need the datasets the constructs read; the rest of the
// file compiles patterns that need none.
ctx.phonetics = parsePhonetics(
  fs.readFileSync("web/public/phonetics.txt", "utf8"),
);
ctx.categories = parseCategories(
  fs.readFileSync("web/public/categories.txt", "utf8"),
);
ctx.lists = parseWikiLists(fs.readFileSync("web/public/lists.txt", "utf8"));
const plan = (q: string) => planQuery(q, ctx);

/** Language size of a query's single conjunct. */
function sizeOf(query: string) {
  const [c] = compileConjuncts(query, ctx);
  return languageSize(innerNfa(c));
}

describe("finiteness", () => {
  it("counts a finite set exactly", () => {
    // 24 Greek letter names, and the count is the point: a planner can decide
    // to enumerate them rather than walk the trie.
    expect(sizeOf("{list:greek}")).toEqual({ finite: true, size: 24 });
    expect(sizeOf("{list:countries}").size).toBe(197);
  });

  it("calls a starred pattern unbounded", () => {
    expect(sizeOf("A*").finite).toBe(false);
    expect(sizeOf("C*").finite).toBe(false);
    expect(sizeOf(".*ee.*").finite).toBe(false);
  });

  it("treats space padding as padding, not as an infinite language", () => {
    // Every unquoted literal carries a space self-loop so it tolerates the
    // corpus's spacing. Counting those as a cycle made *everything*
    // unbounded, including `solar s_stem`, which explains nothing.
    expect(sizeOf("solar s_stem").finite).toBe(true);
    expect(sizeOf("cat").finite).toBe(true);
  });

  it("is finite but uncounted when the set is astronomically large", () => {
    // A{6} is 36^6; enumerating it is not the answer to anything.
    const r = sizeOf("A{6}");
    expect(r.finite).toBe(true);
    expect(r.size).toBeNull();
  });

  it("counts an alternation of literals", () => {
    expect(sizeOf("cat|dog|emu").size).toBe(3);
  });
});

describe("the plan", () => {
  it("separates conjuncts and names the filter shape", () => {
    const p = plan("{list:greek}&A{5}");
    expect(p.conjuncts.length).toBe(2);
    expect(p.filterKind).toBe("product");
    expect(plan("A{5}").filterKind).toBe("single");
  });

  it("labels conjuncts with their source when the split lines up", () => {
    const p = plan("{list:greek}&A{5}");
    expect(p.conjuncts.map((c) => c.source)).toEqual(["{list:greek}", "A{5}"]);
  });

  it("declines to label them when it cannot be sure", () => {
    // An anagram becomes many conjuncts from one fragment; guessing which is
    // which would mislabel them.
    const p = plan("<aciimnrttu>");
    expect(p.conjuncts.length).toBeGreaterThan(1);
    expect(p.conjuncts.every((c) => c.source === null)).toBe(true);
  });

  it("peels the predicate wrappers and reports them separately", () => {
    const p = plan("{palindrome:A{5}}");
    expect(p.pattern).toBe("A{5}");
    expect(p.predicates).toEqual(["palindrome"]);
  });

  it("says a predicate is checked per match rather than searched", () => {
    // The distinction that explains why {palindrome:A{5}} is slow: the
    // pattern does the searching and the filter only rejects afterwards.
    expect(formatPlan(plan("{palindrome:A{5}}")).join("\n")).toContain(
      "checked per match, not searched",
    );
  });

  it("lists the side datasets the query will need", () => {
    expect(plan("A{5}").dataNeeds).toEqual([]);
    expect(plan("{kind:bird}").dataNeeds).toEqual(["categories"]);
    // `greek` is compiled into the bundle, so it needs no catalogue —
    // `romandeities` is harvested and does.
    expect(plan("{rhyme:night}&{list:greek}").dataNeeds).toEqual(["phonetics"]);
    expect(plan("{rhyme:night}&{list:romandeities}").dataNeeds.sort()).toEqual([
      "lists",
      "phonetics",
    ]);
    // Reported for the prefixed form too, which five of the six dataset tests
    // used to miss — see C6.
    expect(plan("{word.rhyme:night}").dataNeeds).toEqual(["phonetics"]);
  });

  it("cannot be planned at all without the data it names", () => {
    // Needing the dataset is exactly why the query will not compile without
    // it, which is what makes `dataNeeds` worth reporting.
    expect(() => planQuery("{kind:bird}", new SessionContext())).toThrow();
  });
});

describe("formatting", () => {
  it("warns when nothing bounds the walk", () => {
    const lines = formatPlan(plan("A*&C*")).join("\n");
    expect(lines).toContain("every conjunct is unbounded");
  });

  it("stays quiet when something does bound it", () => {
    const lines = formatPlan(plan("{list:greek}")).join("\n");
    expect(lines).not.toContain("every conjunct is unbounded");
    expect(lines).toContain("finite, 24 strings");
  });
});

describe("stacked and nested predicates", () => {
  it("reports stacked predicates, not just the outermost", () => {
    // C1 made these stack; the plan reported one.
    const p = planQuery("{palindrome:{syllables=1:A{3}}}", ctx);
    expect(p.predicates).toEqual(["palindrome", "syllables"]);
    expect(p.pattern).toBe("A{3}");
  });

  it("still plans a single query the way planQuery always did", () => {
    const p = planQuery("A{5}&C*", ctx);
    expect(p.pattern).toBe("A{5}&C*");
    expect(p.conjuncts.length).toBe(2);
  });
});

// Which strategy will actually run (P7).
//
// There are two ways to answer a query now, and the plan has to say which one
// this query gets — decided by the same function that decides it at search
// time, so the plan cannot describe a strategy the search then declines.
describe("the strategy in the plan", () => {
  it("says it will test a list when the query is one", () => {
    const p = planQuery("{rhyme:night}&A{5}", ctx);
    expect(p.strategy.kind).toBe("test");
    if (p.strategy.kind !== "test") return;
    expect(p.strategy.candidates).toBe(103);
    // Far fewer are actually looked up: the rest fail the length.
    expect(p.strategy.survivors).toBeLessThan(p.strategy.candidates);
    expect(p.strategy.survivors).toBeGreaterThan(0);
  });

  it("says it will walk when nothing is enumerable", () => {
    expect(planQuery("A{5}&C*", ctx).strategy.kind).toBe("walk");
  });

  it("says it will walk when the candidates are phrases", () => {
    // {kind:bird} is mostly phrases, which a probe cannot price — so the
    // strategy declines and the plan has to say so.
    expect(planQuery("{kind:bird}", ctx).strategy.kind).toBe("walk");
  });

  it("appears in the formatted plan", () => {
    const lines = formatPlan(planQuery("{list:greek}", ctx));
    expect(lines.some((l) => /^strategy: test 24 candidates/.test(l))).toBe(true);
  });
});
