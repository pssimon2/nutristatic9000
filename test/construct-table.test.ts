// The catalogue and the compile table must name the same constructs.
//
// There are two lists of constructs and there has to be: `constructs.ts` says
// what exists and how to describe it, `construct-table.ts` says what each one
// builds. They are read by different code for different reasons, and the whole
// history of this area is lists that drifted — `syllables` was in one and not
// the other, so a construct that plainly worked reported *no such constraint*.
//
// So the drift is what is tested. Not that the lists are equal — they cannot
// be, because the lexer takes a name as letters and `{row1:…}` reaches the
// table as "row" — but that every name a reader can write reaches a row, and
// every row is reachable by writing something.

import { describe, expect, it } from "vitest";
import { CONSTRUCT_BUILDERS } from "../src/construct-table.js";
import { dispatchName, namesAtLevel } from "../src/constructs.js";

const AUTOMATON = [...namesAtLevel("automaton")];

describe("every construct that exists can be built", () => {
  it("has a compile row for every automaton-level name", () => {
    const missing = AUTOMATON.filter((n) => !CONSTRUCT_BUILDERS[dispatchName(n)]);
    expect(missing, "in the catalogue but nothing builds them").toEqual([]);
  });

  it("compares against a catalogue that was actually read", () => {
    // Guards the assertion above: an empty catalogue makes it vacuous.
    expect(AUTOMATON.length).toBeGreaterThan(30);
  });

  it("has no row for a name nobody can write", () => {
    const reachable = new Set(AUTOMATON.map(dispatchName));
    const orphans = Object.keys(CONSTRUCT_BUILDERS).filter((k) => !reachable.has(k));
    expect(orphans, "builds something the catalogue does not offer").toEqual([]);
  });

  it("does not have rows for the other levels", () => {
    // Predicates are applied to finished matches, not intersected with the
    // pattern, so a row here would mean one had been wired into the automaton
    // path by mistake.
    for (const name of namesAtLevel("predicate")) {
      expect(CONSTRUCT_BUILDERS[name], `${name} is a predicate`).toBeUndefined();
    }
  });
});

describe("each row says how its argument is read", () => {
  it("uses one of the three kinds", () => {
    for (const [name, c] of Object.entries(CONSTRUCT_BUILDERS)) {
      expect(["literal", "wrap", "inner"], name).toContain(c.argKind);
    }
  });

  it("reads a literal for the constructs whose argument is data", () => {
    // These take text to look up or decode, so nothing inside the braces is
    // parsed as a query — that is what lets `{rhyme:tree}` mean the word.
    for (const name of ["rhyme", "homo", "like", "near", "kind", "list",
      "sub", "bank", "t9", "enum", "morse", "caesar", "atbash"]) {
      expect(CONSTRUCT_BUILDERS[name].argKind, name).toBe("literal");
    }
  });

  it("reads a pattern for the constructs that constrain one", () => {
    for (const name of ["sum", "distinct", "elements", "ascending"]) {
      expect(CONSTRUCT_BUILDERS[name].argKind, name).toBe("wrap");
    }
  });

  it("reads the argument separately for the edit family", () => {
    // `{del1:beast}` is one letter off its argument rather than an
    // intersection with it, so the argument is built on its own.
    for (const name of ["del", "add", "subst", "edit"]) {
      expect(CONSTRUCT_BUILDERS[name].argKind, name).toBe("inner");
    }
  });
});
