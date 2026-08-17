// Reading a written query's shape: what the engine gets, and what the page
// needs to know to render the answers.
//
// This lived as regexes in web/main.ts, which no unit test could reach — and
// the `{caesar:…}` sniffer was written out twice, four lines apart, which is
// how a rule ends up with two slightly different meanings.

import { describe, expect, it } from "vitest";
import { literalsOf, shapeOfQuery } from "../src/query-shape.js";

const shape = (q: string) => shapeOfQuery(q, 12);

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
