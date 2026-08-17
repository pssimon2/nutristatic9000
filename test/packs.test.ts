// Declarative construct packs (F4): parsed, installed on a session, and
// dispatched by the parser exactly like the built-ins they generalize.

import { describe, expect, it } from "vitest";
import { installPack, parsePack } from "../src/packs.js";
import { SessionContext } from "../src/session-context.js";
import { compileConjuncts, compileQuery } from "../src/find-expr.js";
import { languageSize } from "../src/plan.js";
import { innerNfa } from "../src/conjunct.js";

const PACK = {
  name: "testpack",
  constructs: [
    { name: "vowelish", type: "letter-class", summary: "vowels and y", letters: "aeiouy" },
    { name: "points", type: "value-table", summary: "toy values", values: { a: 5, b: 2, c: 1 } },
    { name: "swap", type: "substitution", summary: "a<->z", map: { a: "z", z: "a" } },
    { name: "row9", type: "letter-class", summary: "digit-bearing name", letters: "qwerty" },
  ],
};

function ctxWith(pack: unknown = PACK): SessionContext {
  const ctx = new SessionContext();
  installPack(ctx, parsePack(pack));
  return ctx;
}

describe("parsePack", () => {
  it("refuses shadowing a built-in", () => {
    expect(() =>
      parsePack({ name: "p", constructs: [{ name: "sum", type: "value-table", values: { a: 1 } }] }),
    ).toThrow(/built-in/);
  });

  it("explains a bad declaration", () => {
    expect(() => parsePack({ name: "p", constructs: [{ name: "x", type: "nope" }] }))
      .toThrow(/letter-class/);
    expect(() =>
      parsePack({ name: "p", constructs: [{ name: "x", type: "letter-class", letters: "a!" }] }),
    ).toThrow(/a-z or digits/);
  });
});

describe("dispatch", () => {
  it("compiles a letter-class like {row1:…}", () => {
    const ctx = ctxWith();
    expect(() => compileQuery("{vowelish:A{4}}", ctx)).not.toThrow();
    // And an unknown name still fails cleanly on a fresh context.
    expect(() => compileQuery("{vowelish:A{4}}", new SessionContext())).toThrow(
      /no such constraint/,
    );
  });

  it("folds digits into a pack name the way the built-ins fold", () => {
    // {row9:…} lexes as name "row" + spec "9"; "row" is a built-in
    // (keyboard rows), whose own table has no row9 — the pack's must win.
    expect(() => compileQuery("{row9:A{4}}", ctxWith())).not.toThrow();
  });

  it("compiles a value-table with the shared comparison grammar", () => {
    const ctx = ctxWith();
    // a=5, b=2, c=1: total 7 over exactly "abc"-ish strings.
    const conjuncts = compileConjuncts("{points=7:[abc]{3}}&abc", ctx);
    expect(conjuncts.length).toBeGreaterThan(0);
    expect(() => compileQuery("{points nonsense:A*}", ctx)).toThrow(/comparison/);
  });

  it("decodes a substitution like a cipher", () => {
    // swap maps a<->z: {swap:za} matches "az".
    const [only] = compileConjuncts("{swap:za}", ctxWith());
    const size = languageSize(innerNfa(only));
    expect(size).toEqual({ finite: true, size: 1 });
  });
});
