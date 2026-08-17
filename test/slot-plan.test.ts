// Slots, and the wrappers that may sit inside or outside them.
//
// The page split multi-slot queries itself, so the CLI could not run one at
// all and nothing tested the splitting except by driving a browser. These are
// the cases that decide what a query means.

import { describe, expect, it } from "vitest";
import { planSlots } from "../src/slot-plan.js";
import { splitSlots } from "../src/query-shape.js";

const plan = (q: string) => planSlots(q, 12);

describe("splitting", () => {
  it("leaves a plain query alone", () => {
    expect(splitSlots("A{5}&C*")).toEqual(["A{5}&C*"]);
  });

  it("splits on top-level semicolons and trims", () => {
    expect(splitSlots(" A{5} ; B{6} ; ")).toEqual(["A{5}", "B{6}"]);
  });

  it("does not split inside braces", () => {
    // The semicolon belongs to the wrapper, not to the query: splitting here
    // produced "{at 1:A{5}" and "B{6}}", neither of which parses.
    expect(splitSlots("{at 1:A{5};B{6}}")).toEqual(["{at 1:A{5};B{6}}"]);
  });

  it("tolerates an unbalanced closing brace rather than going negative", () => {
    expect(splitSlots("A};B")).toEqual(["A}", "B"]);
  });
});

describe("one slot", () => {
  it("peels the wrappers a single query carries", () => {
    const [only] = plan("{at 3:{palindrome:A{5}}}");
    expect(only.pattern).toBe("A{5}");
    expect(only.extract?.positions).toEqual([3]);
    expect(only.filters.map((f) => f.kind)).toEqual(["palindrome"]);
  });

  it("reports no extraction when the query does not ask for one", () => {
    const [only] = plan("A{5}&C*");
    expect(only.pattern).toBe("A{5}&C*");
    expect(only.extract).toBeNull();
    expect(only.rank).toBeNull();
  });
});

describe("several slots", () => {
  it("gives each its own pattern and extraction", () => {
    const slots = plan("{at 1:A{5}};{at 2:B*};C{3}");
    expect(slots.map((s) => s.pattern)).toEqual(["A{5}", "B*", "C{3}"]);
    expect(slots[0].extract?.positions).toEqual([1]);
    expect(slots[1].extract?.positions).toEqual([2]);
    expect(slots[2].extract).toBeNull();
  });

  it("applies a wrapper written outside the slots to every one of them", () => {
    const slots = plan("{at 1:A{5};B{6};C{7}}");
    expect(slots.map((s) => s.pattern)).toEqual(["A{5}", "B{6}", "C{7}"]);
    for (const s of slots) expect(s.extract?.positions, s.query).toEqual([1]);
  });

  it("lets a slot's own wrapper win over the one outside", () => {
    // The outer is a default for slots that do not say; a slot that says
    // where its letter comes from means it.
    const slots = plan("{at 1:A{5};{at 3:B{6}}}");
    expect(slots[0].extract?.positions).toEqual([1]);
    expect(slots[1].extract?.positions).toEqual([3]);
  });

  it("carries predicates per slot", () => {
    const slots = plan("{palindrome:A{5}};{compound 2:A{9}}");
    expect(slots[0].filters.map((f) => f.kind)).toEqual(["palindrome"]);
    expect(slots[1].filters.map((f) => f.kind)).toEqual(["compound"]);
    expect(slots.map((s) => s.pattern)).toEqual(["A{5}", "A{9}"]);
  });

  it("drops empty slots rather than searching for nothing", () => {
    expect(plan("A{5};;B{6};").map((s) => s.pattern)).toEqual(["A{5}", "B{6}"]);
  });

  it("reports a malformed wrapper rather than searching", () => {
    expect(() => plan("{at 0:A{5}};B{6}")).toThrow(/1-based/);
  });
});

// A predicate written around all the slots, which an output wrapper could
// already do.
//
// `{at 1:A{5};A{6}}` was two slots and `{palindrome:A{5};A{6}}` was a parse
// error — the same shape, one working, for no reason a reader could see. Only
// the output wrappers were peeled before the split.
describe("a predicate around all the slots", () => {
  it("applies to each of them", () => {
    const slots = plan("{palindrome:A{5};A{6}}");
    expect(slots.map((s) => s.pattern)).toEqual(["A{5}", "A{6}"]);
    for (const s of slots) {
      expect(s.filters.map((f) => f.kind), s.query).toEqual(["palindrome"]);
    }
  });

  it("adds to what a slot already carries", () => {
    const slots = plan("{palindrome:A{5};{compound 2:A{9}}}");
    expect(slots[0].filters.map((f) => f.kind)).toEqual(["palindrome"]);
    // Outermost first, because the slot's text really is
    // `{palindrome:{compound 2:A{9}}}` — the wrapper is distributed by
    // rewriting the text, so what the worker is handed looks exactly like the
    // single-slot query it is.
    expect(slots[1].filters.map((f) => f.kind)).toEqual(["palindrome", "compound"]);
    expect(slots[1].pattern).toBe("A{9}");
    expect(slots[1].query).toBe("{palindrome:{compound 2:A{9}}}");
  });

  it("leaves a slot alone when it restates the outer predicate", () => {
    // Wrapping it anyway would give `{palindrome:{palindrome:A{7}}}`, which the
    // language refuses as "applied twice". The rule everywhere else is that a
    // slot which says something means it, so its own text stands.
    const slots = plan("{palindrome:A{5};{palindrome:A{7}}}");
    expect(slots[1].filters.map((f) => f.kind)).toEqual(["palindrome"]);
    expect(slots[1].query).toBe("{palindrome:A{7}}");
  });

  it("hands the worker a slot whose text still carries the predicate", () => {
    // The bug this shape had: the plan named the right filters but the page
    // sends `shape.pattern` to the worker, which peels predicates itself — so a
    // slot whose *text* had lost its wrapper searched unfiltered, and
    // `{palindrome:A{5};A{6}}` answered "of the" and "and the".
    for (const s of plan("{palindrome:A{5};A{6}}")) {
      expect(s.shape.pattern, s.query).toMatch(/^\{palindrome:/);
    }
  });

  it("nests under an output wrapper, in the order they peel", () => {
    const slots = plan("{at 1:{palindrome:A{5};A{6}}}");
    expect(slots.length).toBe(2);
    for (const s of slots) {
      expect(s.filters.map((f) => f.kind), s.query).toEqual(["palindrome"]);
      expect(s.extract?.positions, s.query).toEqual([1]);
    }
  });
});
