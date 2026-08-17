// What a query compiles to, described before it runs.
//
// The number that carries the weight is finiteness: a finite conjunct is a set
// the walk can exhaust, an unbounded one is only ever stopped by the step
// budget. Getting it wrong in either direction makes `--explain` worse than
// nothing, so most of these tests are about that judgement.

import { describe, expect, it } from "vitest";
import { formatPlan, languageSize, planQuery,
  planSlotQueries,
} from "../src/plan.js";
import { innerNfa } from "../src/conjunct.js";
import { compileConjuncts } from "../src/find-expr.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();
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

  it("peels the wrappers and reports them separately", () => {
    const p = plan("{at 1:{rank 2-3:{palindrome:A{5}}}}");
    expect(p.pattern).toBe("A{5}");
    expect(p.transforms).toEqual(["at", "rank"]);
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

// Slots, which the planner used to refuse outright.
//
// `{at 1:A{5}};{at 2:B{6}}` came back as *{at …} must wrap the whole pattern*,
// because the whole string was handed to the wrapper parsers — so `--explain`
// failed on exactly the queries C5 had just made runnable, and exited before
// searching at all.
describe("planning a query with several slots", () => {
  it("gives one plan per slot", () => {
    const plans = planSlotQueries("{at 1:A{5}};{at 2:A{6}&C*}", ctx);
    expect(plans.length).toBe(2);
    expect(plans.map((p) => p.pattern)).toEqual(["A{5}", "A{6}&C*"]);
    expect(plans[0].transforms).toEqual(["at"]);
    expect(plans[1].conjuncts.length).toBe(2);
  });

  it("names the slot only when there is more than one", () => {
    const [one] = planSlotQueries("A{5}", ctx);
    expect(one.slot).toBeNull();
    const many = planSlotQueries("A{5};A{6}", ctx);
    expect(many.map((p) => p.slot)).toEqual(["A{5}", "A{6}"]);
  });

  it("plans a wrapper written around all the slots", () => {
    const plans = planSlotQueries("{at 1:A{5};A{6}}", ctx);
    expect(plans.map((p) => p.pattern)).toEqual(["A{5}", "A{6}"]);
    for (const p of plans) expect(p.transforms, p.slot ?? "").toEqual(["at"]);
  });

  it("reports stacked predicates, not just the outermost", () => {
    // C1 made these stack; the plan reported one.
    const [p] = planSlotQueries("{palindrome:{syllables=1:A{3}}}", ctx);
    expect(p.predicates).toEqual(["palindrome", "syllables"]);
    expect(p.pattern).toBe("A{3}");
  });

  it("still plans a single query the way planQuery always did", () => {
    const p = planQuery("A{5}&C*", ctx);
    expect(p.pattern).toBe("A{5}&C*");
    expect(p.conjuncts.length).toBe(2);
  });
});
