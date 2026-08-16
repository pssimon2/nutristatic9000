// What a query compiles to, described before it runs.
//
// The number that carries the weight is finiteness: a finite conjunct is a set
// the walk can exhaust, an unbounded one is only ever stopped by the step
// budget. Getting it wrong in either direction makes `--explain` worse than
// nothing, so most of these tests are about that judgement.

import { describe, expect, it } from "vitest";
import { formatPlan, languageSize, planQuery } from "../src/plan.js";
import { compileConjuncts } from "../src/find-expr.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();
const plan = (q: string) => planQuery(q, ctx);

/** Language size of a query's single conjunct. */
function sizeOf(query: string) {
  const [nfa] = compileConjuncts(query, ctx);
  return languageSize(nfa);
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

  it("peels the wrappers and reports them separately", () => {
    const p = plan("{at 1:{rank 2-3:{palindrome:A{5}}}}");
    expect(p.pattern).toBe("A{5}");
    expect(p.transforms).toEqual(["at", "rank"]);
    expect(p.predicate).toBe("palindrome");
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
    // Not compiled here — needing the data is exactly why it cannot be.
    expect(() => plan("{kind:bird}")).toThrow();
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
