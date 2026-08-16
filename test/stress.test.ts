import * as fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  needsStress,
  parseStress,
  shapeOf,
  syllablesOf,
} from "../src/stress.js";
import { FilterError, parseFilterWrapper } from "../src/result-filter.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

beforeAll(() => {
  ctx.stress = parseStress(fs.readFileSync("web/public/stress.txt", "utf8"));
});

describe("syllables and stress", () => {
  it("knows which queries need the data", () => {
    expect(needsStress("{syllables=3:A*}")).toBe(true);
    expect(needsStress("{stress 100:A*}")).toBe(true);
    expect(needsStress("{sum=100:A*}")).toBe(false);
  });

  it("reads a shape whose length is the syllable count", () => {
    expect(shapeOf(ctx.stress, "computer")).toBe("010");
    expect(syllablesOf(ctx.stress, "computer")).toBe(3);
    expect(syllablesOf(ctx.stress, "cat")).toBe(1);
  });

  it("adds a phrase up word by word", () => {
    expect(shapeOf(ctx.stress, "solar system")).toBe("1010");
    expect(syllablesOf(ctx.stress, "solar system")).toBe(4);
  });

  it("returns null rather than guessing at an unknown word", () => {
    expect(shapeOf(ctx.stress, "zzzqq")).toBeNull();
    expect(syllablesOf(ctx.stress, "solar zzzqq")).toBeNull();
  });

  it("parses the filter specs", () => {
    expect(parseFilterWrapper("{syllables=3:A*}")!.spec).toEqual({
      kind: "syllables",
      lo: 3,
      hi: 3,
    });
    expect(parseFilterWrapper("{syllables<=2:A*}")!.spec).toEqual({
      kind: "syllables",
      lo: 0,
      hi: 2,
    });
    expect(parseFilterWrapper("{stress 100:A*}")!.spec).toEqual({
      kind: "stress",
      shape: "100",
    });
    expect(() => parseFilterWrapper("{stress abc:A*}")).toThrow(FilterError);
    expect(() => parseFilterWrapper("{syllables=x:A*}")).toThrow(FilterError);
  });
});
