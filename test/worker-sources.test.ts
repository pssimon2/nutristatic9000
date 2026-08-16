// Probe interpretation and cache-validator handling, extracted out of
// web/worker.ts (which no unit test could reach) as part of S2.
//
// These decide how large the index is and whether a stored copy may still be
// used. Both failures are quiet: a misread probe opens the index at the wrong
// length, and a mishandled validator either serves bytes from a stale rebuild
// or discards a good multi-gigabyte download.

import { describe, expect, it } from "vitest";
import { validatorFrom, validatorOf } from "../src/byte-source.js";
import {
  VALIDATOR_HEADER,
  cachedCopyStale,
  parseEarlyProbe,
} from "../web/worker/sources.js";
import type { EarlyProbe } from "../web/worker/protocol.js";

function probe(over: Partial<EarlyProbe> = {}): EarlyProbe {
  return {
    ok: true,
    status: 200,
    contentRange: null,
    contentLength: null,
    ...over,
  };
}

describe("parseEarlyProbe", () => {
  it("reads the total from a 206 Content-Range", () => {
    expect(
      parseEarlyProbe(
        probe({ status: 206, contentRange: "bytes 0-0/1234567", contentLength: "1" }),
      ),
    ).toEqual({ length: 1234567, supportsRanges: true, validator: null });
  });

  it("does NOT fall back to Content-Length on an unparseable 206", () => {
    // "bytes 0-0/*" with Content-Length: 1 is the trap — falling through would
    // open a 1.3 GB index as a 1-byte file. Inconclusive must mean re-probe.
    expect(
      parseEarlyProbe(
        probe({ status: 206, contentRange: "bytes 0-0/*", contentLength: "1" }),
      ),
    ).toBeNull();
    expect(
      parseEarlyProbe(probe({ status: 206, contentRange: null, contentLength: "1" })),
    ).toBeNull();
  });

  it("uses Content-Length on a 200, and reports no range support", () => {
    expect(parseEarlyProbe(probe({ contentLength: "4096" }))).toEqual({
      length: 4096,
      supportsRanges: false,
      validator: null,
    });
  });

  it("is inconclusive when the probe failed or said nothing useful", () => {
    expect(parseEarlyProbe(probe({ ok: false, contentLength: "10" }))).toBeNull();
    expect(parseEarlyProbe(probe({ contentLength: null }))).toBeNull();
  });

  it("carries the validator through, from either header alone", () => {
    expect(
      parseEarlyProbe(probe({ contentLength: "10", etag: 'W/"v1"' }))?.validator,
    ).toBe('W/"v1"|');
    expect(
      parseEarlyProbe(probe({ contentLength: "10", lastModified: "Mon, 1 Jan 2024" }))
        ?.validator,
    ).toBe("|Mon, 1 Jan 2024");
  });

  it("agrees with validatorOf, so a cached copy matches its own probe", () => {
    // The page carries two header values and the source carries a Headers;
    // if these two spellings ever diverge, every cached copy looks stale.
    const headers = new Headers({
      etag: 'W/"abc"',
      "last-modified": "Mon, 1 Jan 2024 00:00:00 GMT",
    });
    const fromProbe = parseEarlyProbe(
      probe({
        contentLength: "10",
        etag: headers.get("etag"),
        lastModified: headers.get("last-modified"),
      }),
    );
    expect(fromProbe?.validator).toBe(validatorOf(headers));
  });
});

describe("validatorFrom", () => {
  it("is null only when both parts are absent", () => {
    expect(validatorFrom(null, null)).toBeNull();
    expect(validatorFrom(undefined, undefined)).toBeNull();
    expect(validatorFrom("", "")).toBeNull();
    expect(validatorFrom('W/"x"', null)).toBe('W/"x"|');
  });
});

describe("cachedCopyStale", () => {
  const withValidator = (v: string | null) =>
    new Response("", { headers: v === null ? {} : { [VALIDATOR_HEADER]: v } });

  it("is stale only on a genuine disagreement", () => {
    expect(cachedCopyStale(withValidator("v1"), "v2")).toBe(true);
    expect(cachedCopyStale(withValidator("v1"), "v1")).toBe(false);
  });

  it("keeps the copy when either side has no validator", () => {
    // Without evidence of a change, the size check is all we have; throwing
    // away a 1.3 GB copy on no evidence is the worse error.
    expect(cachedCopyStale(withValidator(null), "v2")).toBe(false);
    expect(cachedCopyStale(withValidator("v1"), null)).toBe(false);
    expect(cachedCopyStale(withValidator(null), null)).toBe(false);
  });
});
