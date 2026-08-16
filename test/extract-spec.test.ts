import { describe, expect, it } from "vitest";
import {
  ExtractError,
  applyExtract,
  parseExtract,
  parseRank,
} from "../src/extract-spec.js";

describe("parseExtract", () => {
  it("does not claim longer names that merely start with it", () => {
    // {atbash:…} is a cipher; {at …} must not swallow it.
    expect(parseExtract("{atbash:gsv}")).toBeNull();
    expect(parseExtract("{atomic:A*}")).toBeNull();
    expect(parseRank("{rankle:A*}")).toBeNull();
  });

  it("returns null for ordinary patterns", () => {
    expect(parseExtract("A{4,8}")).toBeNull();
    expect(parseExtract("<aaagmnr>")).toBeNull();
    expect(parseExtract('"C*aC*e"')).toBeNull();
  });

  it("parses a single position", () => {
    expect(parseExtract("{at 3:A{7}}")).toEqual({
      spec: { positions: [3] },
      inner: "A{7}",
    });
  });

  it("parses negative and multiple positions, and tolerates spacing", () => {
    expect(parseExtract("{at -1:A*}")!.spec.positions).toEqual([-1]);
    expect(parseExtract("{at 3,5,7:A*}")!.spec.positions).toEqual([3, 5, 7]);
    expect(parseExtract("{ at 2 , -2 : A* }")!.spec.positions).toEqual([2, -2]);
  });

  it("keeps braces in the inner pattern balanced", () => {
    // The inner pattern's own {4,8} quantifier must not end the wrapper.
    expect(parseExtract("{at 1:A{4,8} & <abc>}")!.inner).toBe("A{4,8} & <abc>");
  });

  it("rejects malformed or nested wrappers", () => {
    expect(() => parseExtract("A* & {at 3:A*}")).toThrow(ExtractError);
    expect(() => parseExtract("{at 3:A*} & A*")).toThrow(ExtractError);
    expect(() => parseExtract("{at :A*}")).toThrow(ExtractError);
    expect(() => parseExtract("{at 0:A*}")).toThrow(ExtractError);
    expect(() => parseExtract("{at x:A*}")).toThrow(ExtractError);
    expect(() => parseExtract("{at 3:}")).toThrow(ExtractError);
  });
});

describe("applyExtract", () => {
  it("takes 1-based letters", () => {
    expect(applyExtract({ positions: [1] }, "federal")).toBe("f");
    expect(applyExtract({ positions: [3] }, "federal")).toBe("d");
  });

  it("counts from the end for negative positions", () => {
    expect(applyExtract({ positions: [-1] }, "federal")).toBe("l");
    expect(applyExtract({ positions: [-2] }, "federal")).toBe("a");
  });

  it("ignores spaces so phrases index by letter", () => {
    expect(applyExtract({ positions: [4] }, "so lar")).toBe("a");
    expect(applyExtract({ positions: [-1] }, "solar system")).toBe("m");
  });

  it("joins multiple positions in order", () => {
    expect(applyExtract({ positions: [1, 3, -1] }, "federal")).toBe("fdl");
  });

  it("returns null when the match is too short", () => {
    expect(applyExtract({ positions: [9] }, "federal")).toBeNull();
    expect(applyExtract({ positions: [-9] }, "federal")).toBeNull();
  });
});

describe("parseRank", () => {
  it("returns null for ordinary and other-wrapper queries", () => {
    expect(parseRank("A{4,8}")).toBeNull();
    expect(parseRank("{at 3:A*}")).toBeNull();
  });

  it("parses a closed window", () => {
    expect(parseRank("{rank 200-2000:A*}")).toEqual({
      spec: { from: 200, to: 2000 },
      inner: "A*",
    });
  });

  it("treats a bare number as an open end", () => {
    const r = parseRank("{rank 50:A*}")!;
    expect(r.spec.from).toBe(50);
    expect(r.spec.to).toBe(Infinity);
  });

  it("rejects malformed windows", () => {
    expect(() => parseRank("{rank 0-10:A*}")).toThrow(ExtractError);
    expect(() => parseRank("{rank 90-10:A*}")).toThrow(ExtractError);
    expect(() => parseRank("{rank x:A*}")).toThrow(ExtractError);
    expect(() => parseRank("A* & {rank 1-2:A*}")).toThrow(ExtractError);
  });
});

describe("word-relative positions", () => {
  it("parses word.letter pairs", () => {
    expect(parseExtract("{at 2.1:A*}")!.spec.positions).toEqual([
      { word: 2, letter: 1 },
    ]);
    expect(parseExtract("{at -1.1:A*}")!.spec.positions).toEqual([
      { word: -1, letter: 1 },
    ]);
    expect(parseExtract("{at 1.1,-1.-1:A*}")!.spec.positions).toEqual([
      { word: 1, letter: 1 },
      { word: -1, letter: -1 },
    ]);
  });

  it("reads a letter from the chosen word", () => {
    const at = (p: string, text: string) =>
      applyExtract(parseExtract(`{at ${p}:A*}`)!.spec, text);
    expect(at("2.1", "solar system")).toBe("s");
    expect(at("2.3", "solar system")).toBe("s"); // sy[s]tem
    expect(at("-1.1", "of the united states")).toBe("s");
    expect(at("1.-1", "solar system")).toBe("r");
  });

  it("is the case absolute positions can't reach", () => {
    // The last word starts at no fixed offset when what precedes it varies.
    const spec = parseExtract("{at -1.1:A*}")!.spec;
    expect(applyExtract(spec, "a united states")).toBe("s");
    expect(applyExtract(spec, "the united states")).toBe("s");
  });

  it("returns null when the word or letter isn't there", () => {
    const at = (p: string, text: string) =>
      applyExtract(parseExtract(`{at ${p}:A*}`)!.spec, text);
    expect(at("3.1", "solar system")).toBeNull();
    expect(at("1.9", "solar system")).toBeNull();
  });

  it("rejects a zero in either half", () => {
    expect(() => parseExtract("{at 0.1:A*}")).toThrow(ExtractError);
    expect(() => parseExtract("{at 1.0:A*}")).toThrow(ExtractError);
  });
});
