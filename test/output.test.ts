// The output wrappers, which used to be applied separately in the CLI and in
// the page, each keeping its own count of results seen.
//
// The count is the part worth pinning. `{rank 200-2000:…}` is a window into
// the surviving stream, so it has to be advanced by exactly the results that
// got past the predicates, exactly once each — and two implementations of
// "exactly once" is one more than is safe.

import { describe, expect, it } from "vitest";
import { OutputTransform } from "../src/output.js";
import { parseExtract, parseRank } from "../src/extract-spec.js";

const extractOf = (q: string) => parseExtract(q)!.spec;
const rankOf = (q: string) => parseRank(q)!.spec;

describe("with no wrappers", () => {
  it("shows the match unchanged", () => {
    const t = new OutputTransform(null, null);
    expect(t.apply("solar")).toEqual({ text: "solar", source: null });
    expect(t.apply("system")).toEqual({ text: "system", source: null });
  });
});

describe("the rank window", () => {
  it("shows only the results inside it", () => {
    const t = new OutputTransform(null, rankOf("{rank 2-3:A*}"));
    expect(t.apply("a")).toBeNull();
    expect(t.apply("b")?.text).toBe("b");
    expect(t.apply("c")?.text).toBe("c");
    expect(t.apply("d")).toBeNull();
  });

  it("counts the ones it hides, or it would not be a window", () => {
    const t = new OutputTransform(null, rankOf("{rank 3-3:A*}"));
    t.apply("a");
    t.apply("b");
    expect(t.rawRank).toBe(2);
    expect(t.apply("c")?.text).toBe("c");
  });

  it("is 1-based, matching how the results are numbered", () => {
    const t = new OutputTransform(null, rankOf("{rank 1-1:A*}"));
    expect(t.apply("first")?.text).toBe("first");
    expect(t.apply("second")).toBeNull();
  });
});

describe("extraction", () => {
  it("replaces the match and keeps it as the source", () => {
    const t = new OutputTransform(extractOf("{at 1:A*}"), null);
    expect(t.apply("solar")).toEqual({ text: "s", source: "solar" });
  });

  it("drops a match too short for the positions asked for", () => {
    const t = new OutputTransform(extractOf("{at 9:A*}"), null);
    expect(t.apply("cat")).toBeNull();
  });

  it("counts a too-short match, since the rank is taken first", () => {
    // Both front ends already behaved this way; the shared transform must not
    // quietly renumber a rank window that someone has bookmarked.
    const t = new OutputTransform(extractOf("{at 9:A*}"), null);
    t.apply("cat");
    expect(t.rawRank).toBe(1);
  });
});

describe("both together", () => {
  it("applies the window first, then extracts from what survives", () => {
    const t = new OutputTransform(extractOf("{at 1:A*}"), rankOf("{rank 2-2:A*}"));
    expect(t.apply("alpha")).toBeNull(); // outside the window
    expect(t.apply("bravo")).toEqual({ text: "b", source: "bravo" });
    expect(t.apply("congo")).toBeNull();
  });
});

describe("reset", () => {
  it("starts the count again for a new search", () => {
    const t = new OutputTransform(null, rankOf("{rank 1-1:A*}"));
    expect(t.apply("a")?.text).toBe("a");
    expect(t.apply("b")).toBeNull();
    t.reset();
    expect(t.rawRank).toBe(0);
    expect(t.apply("c")?.text).toBe("c");
  });
});
