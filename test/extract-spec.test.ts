import { describe, expect, it } from "vitest";
import {
  ExtractError,
  applyExtract,
  parseExtract,
} from "../src/extract-spec.js";

describe("parseExtract", () => {
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
