// Saying which letter changed.
//
// `{del1:beast}` answers BEST, EAST, BEAT and leaves the reader to find the
// missing letter in each — the tedium the tool exists to remove. The change is
// derivable from the answer and the query together, the same way the caesar
// note already derives its shift, so nothing has to carry provenance through
// the search.

import { describe, expect, it } from "vitest";
import { editNote } from "../src/edit-note.js";
import { shapeOfQuery } from "../src/query-shape.js";

const del1 = { kind: "del", edits: 1, word: "beast" };
const subst1 = { kind: "subst", edits: 1, word: "cargo" };
const add1 = { kind: "add", edits: 1, word: "cargo" };

describe("what one edit did", () => {
  it("names the letter a deletion dropped", () => {
    expect(editNote(del1, "best")).toBe("beast −a");
    expect(editNote(del1, "beat")).toBe("beast −s");
    expect(editNote(del1, "east")).toBe("beast −b");
  });

  it("names both letters a substitution swapped", () => {
    expect(editNote(subst1, "carro")).toBe("cargo g→r");
    expect(editNote(subst1, "largo")).toBe("cargo c→l");
  });

  it("names the letter an insertion added", () => {
    expect(editNote(add1, "cargos")).toBe("cargo +s");
    expect(editNote(add1, "scargo")).toBe("cargo +s");
  });

  it("ignores spaces on either side", () => {
    // "car go" and "cargo" are two answers and the same edit.
    expect(editNote(del1, "be ast")).toBeNull(); // no edit at all
    expect(editNote(del1, "be st")).toBe("beast −a");
  });
});

describe("when it says nothing", () => {
  it("says nothing for the word itself", () => {
    expect(editNote(subst1, "cargo")).toBeNull();
  });

  it("says nothing when the answer is more than one edit away", () => {
    expect(editNote(del1, "bet")).toBeNull();
    expect(editNote(subst1, "cardo x")).toBeNull();
  });

  it("says nothing for a multi-edit construct", () => {
    // Two edits compose several ways; the one chosen would be arbitrary.
    expect(editNote({ kind: "edit", edits: 2, word: "cargo" }, "carts")).toBeNull();
  });

  it("says nothing when there is no edit construct", () => {
    expect(editNote(null, "best")).toBeNull();
  });
});

describe("finding the construct in a query", () => {
  const editOf = (q: string) => shapeOfQuery(q, 12).edit;

  it("reads the kind, the count and the word", () => {
    expect(editOf("{del1:beast}")).toEqual({ kind: "del", edits: 1, word: "beast" });
    expect(editOf("{subst2:cargo}")).toEqual({ kind: "subst", edits: 2, word: "cargo" });
    expect(editOf("{edit<=2:cargo}")).toEqual({ kind: "edit", edits: 2, word: "cargo" });
    // The group prefix is allowed on every construct, so it is allowed here.
    expect(editOf("{edit.del1:beast}")).toEqual({ kind: "del", edits: 1, word: "beast" });
  });

  it("defaults a missing count to one", () => {
    expect(editOf("{del:beast}")?.edits).toBe(1);
  });

  it("declines a set argument, which has no single source", () => {
    // A result may be one letter off several members; guessing one would be
    // worse than saying nothing.
    expect(editOf("{del1:{kind:instrument}}")).toBeNull();
    expect(editOf("{del1:{list:countries}}")).toBeNull();
  });

  it("declines two edit constructs, which cannot be told apart", () => {
    expect(editOf("{del1:beast}&{subst1:cargo}")).toBeNull();
  });

  it("is null for a query with no edit at all", () => {
    expect(editOf("A{5}&C*")).toBeNull();
  });
});
