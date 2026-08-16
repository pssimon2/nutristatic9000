// Reading a written query's shape: what the engine gets, and what the page
// needs to know to render the answers.
//
// This lived as regexes in web/main.ts, which no unit test could reach — and
// the `{caesar:…}` sniffer was written out twice, four lines apart, which is
// how a rule ends up with two slightly different meanings.

import { describe, expect, it } from "vitest";
import { ExtractError } from "../src/extract-spec.js";
import {
  literalsOf,
  shapeOfQuery,
  splitSlots,
} from "../src/query-shape.js";

const shape = (q: string) => shapeOfQuery(q, 12);

describe("splitSlots", () => {
  it("splits on semicolons and trims", () => {
    expect(splitSlots("A{5} ; B{3};C*")).toEqual(["A{5}", "B{3}", "C*"]);
  });

  it("drops empty slots rather than searching for nothing", () => {
    expect(splitSlots("A{5};;  ;B{3}")).toEqual(["A{5}", "B{3}"]);
    expect(splitSlots("   ")).toEqual([]);
  });

  it("leaves a single query alone", () => {
    expect(splitSlots("solar s_stem")).toEqual(["solar s_stem"]);
  });
});

describe("peeling the output wrappers", () => {
  it("returns the pattern untouched when there are none", () => {
    const s = shape("A{5}&C*");
    expect(s.pattern).toBe("A{5}&C*");
    expect(s.extract).toBeNull();
    expect(s.rank).toBeNull();
  });

  it("peels {at …} and reports the spec", () => {
    const s = shape("{at 3:A{7}}");
    expect(s.pattern).toBe("A{7}");
    expect(s.extract).not.toBeNull();
  });

  it("peels {rank …}", () => {
    const s = shape("{rank 200-2000:A{6}}");
    expect(s.pattern).toBe("A{6}");
    expect(s.rank).toEqual({ from: 200, to: 2000 });
  });

  it("peels both, outermost first", () => {
    const s = shape("{at 1:{rank 2-3:A{4}}}");
    expect(s.pattern).toBe("A{4}");
    expect(s.extract).not.toBeNull();
    expect(s.rank).not.toBeNull();
  });

  it("throws on a malformed wrapper rather than searching for it", () => {
    expect(() => shape("{rank nonsense:A*}")).toThrow(ExtractError);
  });
});

describe("the annotatable caesar", () => {
  it("reports the ciphertext of a lone unknown-shift caesar", () => {
    expect(shape("{caesar:kdhv}").caesar).toBe("kdhv");
    // The prefixed spelling is the same construct.
    expect(shape("{cipher.caesar:kdhv}").caesar).toBe("kdhv");
  });

  it("reports nothing when two could each explain a result", () => {
    expect(shape("{caesar:kdhv}&{caesar:abc}").caesar).toBeNull();
  });

  it("reports nothing when there is none", () => {
    expect(shape("A{4}").caesar).toBeNull();
    // A known shift needs no annotation: you already know the answer.
    expect(shape("{rot13:uryyb}").caesar).toBeNull();
  });

  it("looks at the peeled pattern, not the wrapper", () => {
    expect(shape("{at 1:{caesar:kdhv}}").caesar).toBe("kdhv");
  });
});

describe("the ordering {near}", () => {
  it("carries the neighbour count the query asked for", () => {
    // The worker read this with a second regex whose `\d*` was uncaptured, so
    // it always ordered by 32 — {near 200:king} built its pattern from 200
    // neighbours and ordered by a fraction of them, leaving the rest tied.
    expect(shape("{near 200:king}").near).toEqual({ word: "king", limit: 200 });
    expect(shape("{near 8:king}").near).toEqual({ word: "king", limit: 8 });
  });

  it("defaults to the count the parser builds with", () => {
    expect(shape("{near:king}").near).toEqual({ word: "king", limit: 32 });
  });

  it("reads the prefixed spelling too", () => {
    expect(shape("{word.near:king}").near?.word).toBe("king");
  });

  it("orders by nothing when two could each claim it", () => {
    expect(shape("{near:king}&{near:queen}").near).toBeNull();
  });

  it("is null when the query has none", () => {
    expect(shape("A{4}").near).toBeNull();
  });

  it("looks past the wrappers", () => {
    expect(shape("{rank 1-9:{near 12:king}}").near).toEqual({
      word: "king",
      limit: 12,
    });
  });
});

describe("literalsOf", () => {
  it("takes the runs of plain text a pattern demands", () => {
    expect(literalsOf("the quick brown fox", 12)).toEqual(["the quick brown fox"]);
  });

  it("ignores classes and metacharacters, which are never lower case", () => {
    // A, C, V, _ and # are the classes; they cannot appear in a literal run.
    expect(literalsOf("A*C{3}", 3)).toEqual([]);
  });

  it("drops runs too short to be worth folding on", () => {
    expect(literalsOf("cat A* dog", 12)).toEqual([]);
    expect(literalsOf("a very long literal run", 12)).toEqual([
      "a very long literal run",
    ]);
  });
});
