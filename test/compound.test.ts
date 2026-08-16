import { describe, expect, it } from "vitest";
import { parseCompoundSpec, splitsInto } from "../src/compound.js";

const DICT = new Set(["star", "light", "starlight", "car", "toon", "cart", "on", "a"]);
const isWord = (w: string) => DICT.has(w);

describe("parseCompoundSpec", () => {
  it("accepts 2..5 pieces", () => {
    expect(parseCompoundSpec("2")).toEqual({ pieces: 2 });
    expect(parseCompoundSpec(" =3 ")).toEqual({ pieces: 3 });
    expect(parseCompoundSpec("1")).toBeNull(); // just "is a word"
    expect(parseCompoundSpec("6")).toBeNull();
    expect(parseCompoundSpec("x")).toBeNull();
    expect(parseCompoundSpec("")).toBeNull();
  });
});

describe("splitsInto", () => {
  it("finds a two-word cut", async () => {
    expect(await splitsInto("starlight", 2, isWord)).toBe(true);
    expect(await splitsInto("cartoon", 2, isWord)).toBe(true); // car+toon
  });

  it("requires exactly the requested number of pieces", async () => {
    expect(await splitsInto("starlight", 3, isWord)).toBe(false);
    expect(await splitsInto("star", 2, isWord)).toBe(false);
  });

  it("backtracks past a greedy first piece", async () => {
    // "cart" is a word but leaves "oon", which is not; must retry with "car".
    expect(await splitsInto("cartoon", 2, isWord)).toBe(true);
  });

  it("rejects phrases and impossible lengths", async () => {
    expect(await splitsInto("star light", 2, isWord)).toBe(false);
    expect(await splitsInto("a", 2, isWord)).toBe(false);
  });

  it("works with an async check", async () => {
    const slow = async (w: string) => DICT.has(w);
    expect(await splitsInto("starlight", 2, slow)).toBe(true);
    expect(await splitsInto("starlit", 2, slow)).toBe(false);
  });
});

describe("splitWords", () => {
  it("returns the most balanced cut", async () => {
    const { splitWords } = await import("../src/compound.js");
    // "c"+"artoon" and "car"+"toon" and "cart"+"oon" may all be words; the
    // balanced one is the useful reading.
    const dict = new Set(["c", "artoon", "car", "toon", "cart", "oon"]);
    expect(await splitWords("cartoon", 2, (w) => dict.has(w))).toEqual([
      "car",
      "toon",
    ]);
  });

  it("returns null when no cut works", async () => {
    const { splitWords } = await import("../src/compound.js");
    expect(await splitWords("elephant", 2, () => false)).toBeNull();
  });
});
