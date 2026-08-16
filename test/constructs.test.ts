// The construct catalogue and its optional group prefixes.
//
// The prefixes exist because a flat namespace of 45 names put unrelated things
// next to each other — `rot13` (a cipher over a literal) beside `rot180` (the
// letters that survive being turned upside down). These tests pin both that
// the prefixes work and that the bare names never stopped working, since every
// shared query URL uses the bare form.

import { describe, expect, it } from "vitest";
import {
  CONSTRUCTS,
  foldName,
  namesAtLevel,
  namesInGroup,
  qualifiedName,
  resolveConstruct,
  suggestConstruct,
} from "../src/constructs.js";
import { compileQuery } from "../src/find-expr.js";
import { parseFilterWrapper } from "../src/result-filter.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

/** The error a query raises, or null if it compiles. */
function errorOf(pattern: string): string | null {
  try {
    compileQuery(pattern, ctx);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("the catalogue", () => {
  it("gives every construct exactly one group and level", () => {
    const seen = new Set<string>();
    for (const c of CONSTRUCTS) {
      expect(seen.has(c.name), `duplicate ${c.name}`).toBe(false);
      seen.add(c.name);
      expect(c.group, c.name).toBeTruthy();
      expect(c.level, c.name).toBeTruthy();
    }
  });

  it("partitions the names by level and by group", () => {
    const byLevel = (["automaton", "predicate", "transform"] as const).flatMap(
      namesAtLevel,
    );
    expect(byLevel.sort()).toEqual(CONSTRUCTS.map((c) => c.name).sort());
    const groups = [...new Set(CONSTRUCTS.map((c) => c.group))];
    const byGroup = groups.flatMap(namesInGroup);
    expect(byGroup.sort()).toEqual(CONSTRUCTS.map((c) => c.name).sort());
  });

  it("writes a construct whose name is its group without repeating it", () => {
    // {edit.edit<=2:…} would be silly; {edit<=2:…} is the full form.
    expect(qualifiedName({ name: "edit", level: "automaton", group: "edit" }))
      .toBe("edit");
    expect(qualifiedName({ name: "rot180", level: "automaton", group: "shape" }))
      .toBe("shape.rot180");
  });
});

describe("group prefixes", () => {
  it("accepts the prefixed form of a construct", () => {
    expect(errorOf("{cipher.rot13:uryyb}")).toBeNull();
    expect(errorOf("{shape.rot180:A{4}}")).toBeNull();
    expect(errorOf("{spell.t9:2665}")).toBeNull();
    expect(errorOf("{shape.row1:A{5}}")).toBeNull();
    expect(errorOf("{count.sum=52:A*}")).toBeNull();
    expect(errorOf("{word.list:greek}")).toBeNull();
    expect(errorOf("{edit.del1:beast}")).toBeNull();
    expect(errorOf("{bag.sub:cryptography}")).toBeNull();
  });

  it("still accepts every bare name — shared URLs use them", () => {
    expect(errorOf("{rot13:uryyb}")).toBeNull();
    expect(errorOf("{rot180:A{4}}")).toBeNull();
    expect(errorOf("{t9:2665}")).toBeNull();
    expect(errorOf("{sum=52:A*}")).toBeNull();
  });

  it("names the right group when the wrong one is given", () => {
    const e = errorOf("{shape.rot13:uryyb}");
    expect(e).toMatch(/is in cipher, not shape/);
    expect(e).toMatch(/\{cipher\.rot13…\}/);
  });

  it("separates rot13 from rot180, which is the whole point", () => {
    // Same three-letter stem, different families. Each rejects the other's
    // group rather than quietly building the wrong automaton.
    expect(errorOf("{cipher.rot180:A{4}}")).toMatch(/is in shape, not cipher/);
    expect(errorOf("{shape.rot13:uryyb}")).toMatch(/is in cipher, not shape/);
    // And each still works under its own.
    expect(errorOf("{cipher.rot13:uryyb}")).toBeNull();
    expect(errorOf("{shape.rot180:A{4}}")).toBeNull();
  });

  it("rejects a group that does not exist", () => {
    expect(errorOf("{bogus.rot13:x}")).toMatch(/no such group "bogus"/);
  });

  it("applies to the wrapper constructs too", () => {
    expect(parseFilterWrapper("{match.palindrome:A{5}}")?.spec).toEqual({
      kind: "palindrome",
    });
    expect(parseFilterWrapper("{palindrome:A{5}}")?.spec).toEqual({
      kind: "palindrome",
    });
    expect(() => parseFilterWrapper("{cipher.palindrome:A{5}}")).toThrow(
      /is in match, not cipher/,
    );
  });

  it("reaches every construct through its own qualified name", () => {
    // A construct with no working prefix would be invisible to grouped help.
    for (const c of CONSTRUCTS) {
      const resolved = resolveConstruct(qualifiedName(c), "");
      expect(resolved, c.name).not.toBeNull();
      expect(resolved && "info" in resolved && resolved.info.name, c.name).toBe(
        c.name,
      );
    }
  });
});

describe("foldName", () => {
  it("is the single rule both the parser and the group check use", () => {
    expect(foldName("rot", "180")).toEqual({ name: "rot180", spec: "" });
    expect(foldName("t", "9")).toEqual({ name: "t9", spec: "" });
    // Everything else passes through, digits and all.
    expect(foldName("rot", "13")).toEqual({ name: "rot", spec: "13" });
    expect(foldName("del", "1")).toEqual({ name: "del", spec: "1" });
  });
});

describe("suggestions and misplacement", () => {
  it("suggests names at every level, not just the automaton ones", () => {
    // `syllables` and `stress` were missing from the list the typo-matcher
    // read, so a near miss on them got no suggestion at all.
    expect(suggestConstruct("sillables")).toBe("syllables");
    expect(suggestConstruct("stres")).toBe("stress");
    expect(suggestConstruct("palindrone")).toBe("palindrome");
    expect(suggestConstruct("sumx")).toBe("sum");
    expect(suggestConstruct("zzzzzzzz")).toBeNull();
  });

  it("says where a real construct belongs instead of denying it exists", () => {
    // The old message was `no such constraint "syllables"` — for a construct
    // that works one position away.
    const e = errorOf("A{4} {syllables=3:A{7}}");
    expect(e).toMatch(/wrap the whole query/);
    expect(e).not.toMatch(/no such constraint/);
    expect(errorOf("{at 1:A*}")).toMatch(/changes what is shown/);
  });
});
