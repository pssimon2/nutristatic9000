// The download-resume arithmetic, which had no test before it was extracted
// out of web/worker.ts. It decides which bytes of a partially-downloaded index
// still need fetching, so an off-by-one here either re-downloads a 1.3 GB file
// or — worse — declares a file complete with a hole in it.

import { describe, expect, it } from "vitest";
import {
  addRange,
  coveredBytes,
  opfsName,
  opfsOkName,
  parseOpfsMarker,
  parseOpfsProg,
  progName,
  rangeCovered,
  validatorOk,
} from "../web/worker/storage.js";

/** Build a range list by inserting in the given order. */
function built(...spans: Array<[number, number]>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const [s, e] of spans) addRange(ranges, s, e);
  return ranges;
}

describe("addRange", () => {
  it("keeps the list sorted regardless of insertion order", () => {
    expect(built([50, 60], [10, 20], [30, 40])).toEqual([
      [10, 20],
      [30, 40],
      [50, 60],
    ]);
  });

  it("coalesces touching ranges into one", () => {
    // [10,20) and [20,30) are contiguous, not overlapping: half-open ranges
    // meeting at 20 cover [10,30) with no gap.
    expect(built([10, 20], [20, 30])).toEqual([[10, 30]]);
  });

  it("merges an overlap", () => {
    expect(built([10, 30], [20, 40])).toEqual([[10, 40]]);
  });

  it("swallows a range contained in an existing one", () => {
    expect(built([10, 100], [40, 50])).toEqual([[10, 100]]);
  });

  it("bridges several ranges with one spanning insert", () => {
    expect(built([10, 20], [30, 40], [50, 60], [15, 55])).toEqual([[10, 60]]);
  });

  it("leaves a genuine gap alone", () => {
    expect(built([10, 20], [21, 30])).toEqual([
      [10, 20],
      [21, 30],
    ]);
  });

  it("ignores empty and inverted spans", () => {
    expect(built([10, 10])).toEqual([]);
    expect(built([20, 10])).toEqual([]);
    expect(built([10, 20], [15, 15])).toEqual([[10, 20]]);
  });

  it("is idempotent: re-adding a covered piece changes nothing", () => {
    const ranges = built([0, 4 << 20]);
    addRange(ranges, 0, 4 << 20);
    expect(ranges).toEqual([[0, 4 << 20]]);
  });
});

describe("rangeCovered", () => {
  const ranges = built([10, 20], [30, 40]);

  it("accepts a fully covered span and its exact bounds", () => {
    expect(rangeCovered(ranges, 12, 18)).toBe(true);
    expect(rangeCovered(ranges, 10, 20)).toBe(true);
  });

  it("rejects a span crossing a gap or running past the end", () => {
    expect(rangeCovered(ranges, 15, 35)).toBe(false);
    expect(rangeCovered(ranges, 18, 25)).toBe(false);
    expect(rangeCovered(ranges, 35, 45)).toBe(false);
  });

  it("rejects a span in a gap entirely", () => {
    expect(rangeCovered(ranges, 22, 28)).toBe(false);
  });

  it("treats an empty span as covered", () => {
    expect(rangeCovered([], 10, 10)).toBe(true);
    expect(rangeCovered([], 20, 10)).toBe(true);
  });

  it("rejects everything against an empty list", () => {
    expect(rangeCovered([], 0, 1)).toBe(false);
  });
});

describe("coveredBytes", () => {
  it("sums the spans", () => {
    expect(coveredBytes([])).toBe(0);
    expect(coveredBytes(built([10, 20], [30, 45]))).toBe(25);
  });

  it("counts a merged range once, not twice", () => {
    expect(coveredBytes(built([10, 30], [20, 40]))).toBe(30);
  });
});

describe("parseOpfsMarker", () => {
  it("reads the current JSON form", () => {
    expect(parseOpfsMarker('{"size":123,"validator":"W/\\"abc\\""}')).toEqual({
      size: 123,
      validator: 'W/"abc"',
    });
  });

  it("reads the legacy bare-number form", () => {
    expect(parseOpfsMarker("123")).toEqual({ size: 123, validator: null });
  });

  it("defaults a missing validator to null", () => {
    expect(parseOpfsMarker('{"size":7}')).toEqual({ size: 7, validator: null });
  });

  it("rejects absent, empty, malformed and sizeless records", () => {
    expect(parseOpfsMarker(null)).toBeNull();
    expect(parseOpfsMarker("")).toBeNull();
    expect(parseOpfsMarker("{not json")).toBeNull();
    expect(parseOpfsMarker('{"validator":"x"}')).toBeNull();
    expect(parseOpfsMarker('{"size":"123"}')).toBeNull();
  });
});

describe("parseOpfsProg", () => {
  it("reads a well-formed record", () => {
    expect(parseOpfsProg('{"size":9,"validator":null,"ranges":[[0,4]]}')).toEqual(
      { size: 9, validator: null, ranges: [[0, 4]] },
    );
  });

  it("rejects records whose ranges are not number pairs", () => {
    expect(parseOpfsProg('{"size":9,"ranges":[[0]]}')).toBeNull();
    expect(parseOpfsProg('{"size":9,"ranges":[[0,"4"]]}')).toBeNull();
    expect(parseOpfsProg('{"size":9,"ranges":"nope"}')).toBeNull();
    expect(parseOpfsProg('{"ranges":[[0,4]]}')).toBeNull();
  });

  it("treats absent and corrupt records as no progress", () => {
    expect(parseOpfsProg(null)).toBeNull();
    expect(parseOpfsProg("{trunc")).toBeNull();
  });
});

describe("validatorOk", () => {
  it("accepts a match, and accepts when either side is unknown", () => {
    expect(validatorOk("etag-1", "etag-1")).toBe(true);
    expect(validatorOk(null, "etag-1")).toBe(true);
    expect(validatorOk("etag-1", null)).toBe(true);
    expect(validatorOk(undefined, "etag-1")).toBe(true);
  });

  it("rejects a genuine mismatch — the index changed under the copy", () => {
    expect(validatorOk("etag-1", "etag-2")).toBe(false);
  });
});

describe("OPFS file naming", () => {
  it("derives the marker and progress names from the index name", () => {
    const url = "https://example.org/en-wiki.index";
    expect(opfsOkName(url)).toBe(`${opfsName(url)}.ok`);
    expect(progName(url)).toBe(`${opfsName(url)}.prog`);
  });

  it("escapes the URL so slashes cannot create directories", () => {
    expect(opfsName("https://example.org/a/b.index")).not.toContain("/");
  });

  it("gives different indexes different names", () => {
    expect(opfsName("https://a.example/x.index")).not.toBe(
      opfsName("https://b.example/x.index"),
    );
  });
});
