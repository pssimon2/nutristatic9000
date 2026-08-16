import { describe, expect, it } from "vitest";
import {
  FilterError,
  isPalindrome,
  letters,
  parseFilterWrapper,
  reversed,
} from "../src/result-filter.js";

describe("parseFilterWrapper", () => {
  it("ignores queries that aren't result filters", () => {
    expect(parseFilterWrapper("A{5}")).toBeNull();
    expect(parseFilterWrapper("{sum=100:A*}")).toBeNull(); // an engine constraint
  });

  it("parses each filter", () => {
    expect(parseFilterWrapper("{compound 2:A{9}}")).toEqual({
      spec: { kind: "compound", pieces: 2 },
      inner: "A{9}",
    });
    expect(parseFilterWrapper("{palindrome:A{5}}")!.spec).toEqual({
      kind: "palindrome",
    });
    expect(parseFilterWrapper("{reversible:A{8}}")!.spec).toEqual({
      kind: "reversible",
    });
  });

  it("explains itself when malformed", () => {
    expect(() => parseFilterWrapper("{compound 1:A*}")).toThrow(FilterError);
    expect(() => parseFilterWrapper("{compound 9:A*}")).toThrow(FilterError);
    expect(() => parseFilterWrapper("{palindrome 2:A*}")).toThrow(FilterError);
    expect(() => parseFilterWrapper("{compound 2:}")).toThrow(FilterError);
  });
});

describe("palindromes and reversal", () => {
  it("ignores where the words fall", () => {
    expect(isPalindrome("racecar")).toBe(true);
    expect(isPalindrome("never odd or even")).toBe(true);
    expect(isPalindrome("madam")).toBe(true);
    expect(isPalindrome("cat")).toBe(false);
    expect(isPalindrome("a")).toBe(false); // not a puzzle answer
  });

  it("reverses letters only", () => {
    expect(reversed("desserts")).toBe("stressed");
    expect(reversed("solar system")).toBe("metsysralos");
    expect(letters("of the")).toBe("ofthe");
  });
});
