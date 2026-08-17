// The notes derived from a query and its answer, in one place for both front
// ends.
//
// A predicate produces its own note and that travels with the verdict, so both
// front ends have always shown it. The other kind is derived afterwards — which
// Caesar shift maps the ciphertext to this word, which letter an edit changed —
// and needs nothing carried through the search, so it was written where it was
// first needed: in the page. The CLI therefore showed none of it. `{caesar:kdhv}`
// printed "pima" with no shift beside it while the page printed "caesar +5".

import { describe, expect, it } from "vitest";
import { derivedNote } from "../src/match-notes.js";
import { shapeOfQuery } from "../src/query-shape.js";

const note = (query: string, text: string) =>
  derivedNote(shapeOfQuery(query, 12), text);

describe("the Caesar shift that matched", () => {
  it("names the shift", () => {
    // KDHV is HAES shifted by 3, so the answer HAES... in this corpus the
    // shift is whatever maps the ciphertext onto the answer.
    expect(note("{caesar:kdhv}", "pima")).toBe("caesar +5");
    expect(note("{caesar:kdhv}", "slpd")).toBe("caesar +8");
  });

  it("says nothing when no single shift maps one to the other", () => {
    expect(note("{caesar:kdhv}", "abcz")).toBeNull(); // inconsistent
    expect(note("{caesar:kdhv}", "toolong")).toBeNull(); // wrong length
  });

  it("ignores spaces, which the index puts in and a cipher does not", () => {
    expect(note("{caesar:kd hv}", "pi ma")).toBe("caesar +5");
  });

  it("says nothing when the query has no lone caesar", () => {
    expect(note("A{4}", "pima")).toBeNull();
    // Two of them: no saying which produced what.
    expect(note("{caesar:kdhv}&{caesar:abcd}", "pima")).toBeNull();
  });
});

describe("the letter an edit changed", () => {
  it("names it", () => {
    expect(note("{del1:beast}", "best")).toBe("beast −a");
    expect(note("{subst1:cargo}", "carlo")).toBe("cargo g→l");
    expect(note("{add1:cargo}", "cargos")).toBe("cargo +s");
  });

  it("says nothing for a set argument or a multi-edit", () => {
    expect(note("{del1:{list:countries}}", "spain")).toBeNull();
    expect(note("{edit<=2:cargo}", "carts")).toBeNull();
  });
});

describe("one rule, not one per front end", () => {
  it("gives the same answer whoever asks", () => {
    // The page and the CLI both call this function on the same shape, so there
    // is nothing left to diverge. Pinned as a property rather than by
    // inspecting two call sites: a note either comes from here or from a
    // predicate's verdict, and both are shared.
    const shape = shapeOfQuery("{del1:beast}", 12);
    const first = derivedNote(shape, "best");
    const second = derivedNote(shape, "best");
    expect(first).toBe(second);
    expect(first).toBe("beast −a");
  });

  it("has nothing to say about a query with neither", () => {
    expect(note("{palindrome:A{5}}", "level")).toBeNull();
    expect(note("A{5}&C*", "solar")).toBeNull();
  });
});
