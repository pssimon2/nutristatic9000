// The result-filter rule, which the CLI and the worker now share. Both copies
// were previously untested: result-filter.test.ts covers the *parsing* of
// {palindrome:…} and friends, but nothing exercised the per-match decision or
// the annotation it produces.

import { describe, expect, it } from "vitest";
import {
  applyResultFilter,
  applyResultFilters,
  nearOrderKey,
} from "../src/result-predicate.js";
import { FilterError, parseFilterWrappers } from "../src/result-filter.js";
import { SessionContext } from "../src/session-context.js";
import { parseStress } from "../src/stress.js";

const ctx = new SessionContext();
ctx.stress = parseStress(
  ["computer 010", "cat 1", "solar 10", "system 10", "level 10"].join("\n"),
);

/** An index that knows exactly these words. */
const knows = (...words: string[]) => {
  const set = new Set(words);
  return (w: string) => set.has(w);
};
const knowsNothing = () => false;

describe("palindrome", () => {
  const spec = { kind: "palindrome" } as const;

  it("keeps a palindrome, with no annotation", async () => {
    expect(await applyResultFilter(spec, "level", ctx, knowsNothing)).toEqual({
      keep: true,
      note: null,
    });
  });

  it("ignores where the spaces fall", async () => {
    expect((await applyResultFilter(spec, "ne ver even", ctx, knowsNothing)).keep).toBe(
      true,
    );
  });

  it("drops a non-palindrome, and a single letter", async () => {
    expect((await applyResultFilter(spec, "cat", ctx, knowsNothing)).keep).toBe(false);
    expect((await applyResultFilter(spec, "a", ctx, knowsNothing)).keep).toBe(false);
  });
});

describe("reversible", () => {
  const spec = { kind: "reversible" } as const;

  it("keeps a word whose mirror is indexed, annotated with the mirror", async () => {
    expect(await applyResultFilter(spec, "trap", ctx, knows("part"))).toEqual({
      keep: true,
      note: "← part",
    });
  });

  it("drops it when the mirror is not a word", async () => {
    expect((await applyResultFilter(spec, "trap", ctx, knowsNothing)).keep).toBe(false);
  });

  it("drops a palindrome: its own reverse is not a second answer", async () => {
    expect((await applyResultFilter(spec, "level", ctx, knows("level"))).keep).toBe(
      false,
    );
  });
});

describe("syllables", () => {
  it("keeps a count inside the window and reports it", async () => {
    const spec = { kind: "syllables", lo: 3, hi: 3 } as const;
    expect(await applyResultFilter(spec, "computer", ctx, knowsNothing)).toEqual({
      keep: true,
      note: "3 syll",
    });
  });

  it("adds up across words of a phrase", async () => {
    const spec = { kind: "syllables", lo: 4, hi: 4 } as const;
    expect((await applyResultFilter(spec, "solar system", ctx, knowsNothing)).keep).toBe(
      true,
    );
  });

  it("drops counts outside the window", async () => {
    const spec = { kind: "syllables", lo: 2, hi: 2 } as const;
    expect((await applyResultFilter(spec, "computer", ctx, knowsNothing)).keep).toBe(
      false,
    );
  });

  it("drops a phrase with a word the dictionary lacks", async () => {
    // A partial count would be wrong rather than approximate.
    const spec = { kind: "syllables", lo: 1, hi: 99 } as const;
    expect((await applyResultFilter(spec, "solar zzzqq", ctx, knowsNothing)).keep).toBe(
      false,
    );
  });
});

describe("stress", () => {
  it("matches a shape and reports it", async () => {
    const spec = { kind: "stress", shape: "010" } as const;
    expect(await applyResultFilter(spec, "computer", ctx, knowsNothing)).toEqual({
      keep: true,
      note: "010",
    });
  });

  it("treats secondary stress as stressed on both sides", async () => {
    const withSecondary = new SessionContext();
    withSecondary.stress = parseStress("dynamo 102\n");
    // The stored shape has a 2; the requested shape spells it 1. They match.
    const spec = { kind: "stress", shape: "101" } as const;
    const v = await applyResultFilter(spec, "dynamo", withSecondary, knowsNothing);
    expect(v.keep).toBe(true);
    // The note shows the real shape, not the folded one.
    expect(v.note).toBe("102");
  });

  it("drops a different shape", async () => {
    const spec = { kind: "stress", shape: "100" } as const;
    expect((await applyResultFilter(spec, "computer", ctx, knowsNothing)).keep).toBe(
      false,
    );
  });

  it("drops when the word is unknown", async () => {
    const spec = { kind: "stress", shape: "1" } as const;
    expect((await applyResultFilter(spec, "zzzqq", ctx, knowsNothing)).keep).toBe(false);
  });
});

describe("compound", () => {
  it("keeps a match that cuts into indexed words, showing the cut", async () => {
    const spec = { kind: "compound", pieces: 2 } as const;
    expect(
      await applyResultFilter(spec, "copyright", ctx, knows("copy", "right")),
    ).toEqual({ keep: true, note: "copy·right" });
  });

  it("drops a match with no valid split", async () => {
    const spec = { kind: "compound", pieces: 2 } as const;
    expect(
      (await applyResultFilter(spec, "copyright", ctx, knows("copy"))).keep,
    ).toBe(false);
  });

  it("awaits an async index probe (range mode fetches bytes)", async () => {
    const spec = { kind: "compound", pieces: 2 } as const;
    const asyncKnows = async (w: string) => ["copy", "right"].includes(w);
    expect((await applyResultFilter(spec, "copyright", ctx, asyncKnows)).note).toBe(
      "copy·right",
    );
  });
});

describe("nearOrderKey", () => {
  const order = new Map([
    ["king", 0],
    ["monarch", 1],
    ["queen", 2],
  ]);

  it("ranks by position in the neighbour list", () => {
    expect(nearOrderKey(order, "king")).toBe(0);
    expect(nearOrderKey(order, "queen")).toBe(2);
  });

  it("ranks a phrase by its nearest word", () => {
    expect(nearOrderKey(order, "queen monarch")).toBe(1);
  });

  it("sorts anything unmentioned after everything mentioned", () => {
    expect(nearOrderKey(order, "aardvark")).toBe(Infinity);
    const sorted = ["aardvark", "queen", "king"].sort(
      (a, b) => nearOrderKey(order, a) - nearOrderKey(order, b),
    );
    expect(sorted).toEqual(["king", "queen", "aardvark"]);
  });
});

describe("stacked filters", () => {
  // `{palindrome:{syllables=3:A{7}}}` used to report that syllables cannot be
  // nested — a correct message about the wrong problem, since only one
  // wrapper could ever be peeled.
  it("peels every wrapper, outermost first", () => {
    const { specs, inner } = parseFilterWrappers(
      "{palindrome:{syllables=3:A{7}}}",
    );
    expect(specs.map((s) => s.kind)).toEqual(["palindrome", "syllables"]);
    expect(inner).toBe("A{7}");
  });

  it("leaves a plain query alone", () => {
    const { specs, inner } = parseFilterWrappers("A{5}&C*");
    expect(specs).toEqual([]);
    expect(inner).toBe("A{5}&C*");
  });

  it("means AND: a match must satisfy all of them", async () => {
    const both = [
      { kind: "palindrome" } as const,
      { kind: "syllables", lo: 1, hi: 1 } as const,
    ];
    // "level" is a palindrome, but two syllables.
    expect((await applyResultFilters(both, "level", ctx, knowsNothing)).keep).toBe(
      false,
    );
    // "cat" is one syllable, but no palindrome.
    expect((await applyResultFilters(both, "cat", ctx, knowsNothing)).keep).toBe(
      false,
    );
  });

  it("collects a note from each filter that has one", async () => {
    const v = await applyResultFilters(
      [{ kind: "syllables", lo: 3, hi: 3 }, { kind: "reversible" }],
      "computer",
      ctx,
      knows("retupmoc"),
    );
    expect(v.keep).toBe(true);
    expect(v.notes).toEqual(["3 syll", "← retupmoc"]);
  });

  it("stops at the first rejection rather than paying for the rest", async () => {
    // {compound} probes the index and may fetch bytes; a cheap rejection in
    // front of it must not run it.
    let probed = 0;
    const counting = (w: string) => {
      ++probed;
      return w === "never";
    };
    const v = await applyResultFilters(
      [{ kind: "palindrome" }, { kind: "compound", pieces: 2 }],
      "cat",
      ctx,
      counting,
    );
    expect(v.keep).toBe(false);
    expect(probed).toBe(0);
  });

  it("rejects the same filter twice as a question nobody means to ask", () => {
    expect(() => parseFilterWrappers("{palindrome:{palindrome:A{5}}}")).toThrow(
      FilterError,
    );
  });

  it("requires the wrapper to close the whole query", () => {
    // Only `endsWith("}")` was checked, so this parsed as one wrapper whose
    // inner pattern was `A}{bank:xyz` and failed pointing at the wrong thing.
    expect(() => parseFilterWrappers("{palindrome:A}{bank:xyz}")).toThrow(
      /must wrap the whole pattern/,
    );
  });
});
