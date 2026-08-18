// `{iso:…}` — the cryptogram predicate: same letter pattern as the
// ciphertext under a one-to-one mapping. The hull prunes by shape and by
// pinning the repeated letters; the verifier holds the full isomorphism —
// these tests exercise both halves through the front ends' own path.

import { describe, expect, it } from "vitest";
import { compileQuery } from "../src/find-expr.js";
import { applyResultFilters } from "../src/result-predicate.js";
import { parseFilterWrappers } from "../src/result-filter.js";
import { ParseError } from "../src/parse-error.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

/** Hull acceptance only — what the search itself would explore. */
function hullAccepts(pattern: string, text: string): boolean {
  const filter = compileQuery(pattern, ctx);
  let state = filter.startState;
  for (const ch of `${text} `) {
    state = filter.transition(state, ch.charCodeAt(0));
    if (state < 0) return false;
  }
  return filter.isAccepting(state);
}

/** The full verdict: hull + verification, as the worker and CLI decide it. */
async function verdict(query: string, text: string) {
  expect(hullAccepts(query, text)).toBe(true);
  const { specs } = parseFilterWrappers(query);
  expect(specs.length, `${query} should carry the iso predicate`).toBeGreaterThan(0);
  return applyResultFilters(specs, text, ctx, () => false);
}

async function keeps(query: string, text: string): Promise<boolean> {
  if (!hullAccepts(query, text)) return false;
  const { specs } = parseFilterWrappers(query);
  return (await applyResultFilters(specs, text, ctx, () => false)).keep;
}

describe("the hull", () => {
  it("pins repeated letters, so shape mismatches never reach the verifier", () => {
    expect(hullAccepts("{iso:xjxj}", "coco")).toBe(true);
    expect(hullAccepts("{iso:xjxj}", "cargo")).toBe(false); // wrong length
    expect(hullAccepts("{iso:xjxj}", "cocs")).toBe(false); // x repeats, c≠s
    expect(hullAccepts("{iso:xjxj}", "aaaa")).toBe(false); // pins are injective
  });

  it("puts word breaks where the ciphertext has them", () => {
    expect(hullAccepts("{iso:ab ba}", "no on")).toBe(true);
    expect(hullAccepts("{iso:ab ba}", "noon")).toBe(false);
  });

  it("stays bounded on a long ciphertext with many repeats", () => {
    const cipher = "wklv lv d orqj vwulqj ri zrugv wr slq";
    expect(hullAccepts(`{iso:${cipher}}`, cipher)).toBe(true); // identity map
  });
});

describe("the verdict", () => {
  it("keeps isomorphic text and reports the mapping as the key", async () => {
    const v = await verdict("{iso:xjxj}", "coco");
    expect(v.keep).toBe(true);
    expect(v.notes).toContain("x→c j→o");
  });

  it("demands consistency beyond what the hull pinned", async () => {
    // Four distinct cipher letters: nothing repeats, so nothing is pinned
    // and the hull is shape-only — the verifier must still demand that
    // distinct cipher letters land on distinct plaintext letters.
    expect(await keeps("{iso:abcd}", "wxyz")).toBe(true);
    expect(await keeps("{iso:abcd}", "wxyw")).toBe(false);
  });

  it("allows the identity mapping — a letter may stand for itself", async () => {
    expect(await keeps("{iso:cat}", "cat")).toBe(true);
  });

  it("holds one consistent key across word breaks", async () => {
    // j appears in both words and must land on the same letter each time.
    expect(await keeps("{iso:xjxj yjkw}", "coco honk")).toBe(true);
    expect(await keeps("{iso:xjxj yjkw}", "coco help")).toBe(false); // j→o, then e
    // Injectivity spans words too: b and c may not share a plaintext letter.
    expect(await keeps("{iso:ab cd}", "to in")).toBe(true);
    expect(await keeps("{iso:ab cd}", "to on")).toBe(false);
  });
});

describe("composition", () => {
  it("sits beside a neighbour and holds of its own span", async () => {
    expect(await keeps("{iso:xjxj} A{3}", "coco nut")).toBe(true);
    expect(await keeps("A{3} {iso:xjxj}", "nut coco")).toBe(true);
    expect(await keeps("{iso:xjxj} A{3}", "cost nut")).toBe(false);
  });

  it("intersects and alternates", async () => {
    expect(await keeps("{iso:xjxj}&c.*", "coco")).toBe(true);
    expect(await keeps("({iso:abab}|door)", "door")).toBe(true);
    expect(await keeps("({iso:abab}|door)", "gogo")).toBe(true);
  });
});

describe("errors", () => {
  it("rejects non-letter ciphertext, an empty one, and a stray spec", () => {
    expect(() => compileQuery("{iso:12}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("{iso:}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("{iso x:abc}", ctx)).toThrow(/ciphertext/);
  });
});
