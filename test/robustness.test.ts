// Edge-case coverage for the tricky support layers: idxz sidecar parsing on
// malformed input, SyncFileSource chunking, quantifier bounds, and the
// friendly not-an-index error.

import { describe, expect, it } from "vitest";
import {
  IDXZ_BLOCK_SIZE,
  IDXZ_HEADER_SIZE,
  buildIdxzHeader,
  inflateRawBlock,
  parseIdxzHeader,
  parseIdxzTable,
} from "../src/idxz.js";
import { MemorySource, SyncFileReader, SyncFileSource, ViewHolder } from "../src/byte-source.js";
import { IndexReader } from "../src/index-reader.js";
import { compileQuery } from "../src/find-expr.js";
import { ParseError } from "../src/parse-error.js";
import { SessionContext } from "../src/session-context.js";

const ctx = new SessionContext();

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("idxz parsing", () => {
  it("round-trips a header", () => {
    const h = parseIdxzHeader(buildIdxzHeader(IDXZ_BLOCK_SIZE, 1_000_000, 42));
    expect(h).toMatchObject({
      blockSize: IDXZ_BLOCK_SIZE,
      uncompressedSize: 1_000_000,
      tableBytes: 42,
      dataStart: IDXZ_HEADER_SIZE + 42,
      numBlocks: Math.ceil(1_000_000 / IDXZ_BLOCK_SIZE),
    });
  });

  it("rejects truncated, mismagicked, and zeroed headers", () => {
    const good = buildIdxzHeader(IDXZ_BLOCK_SIZE, 1_000_000, 42);
    expect(parseIdxzHeader(good.subarray(0, IDXZ_HEADER_SIZE - 1))).toBeNull();
    expect(parseIdxzHeader(new Uint8Array(0))).toBeNull();
    const badMagic = good.slice();
    badMagic[0] ^= 0xff;
    expect(parseIdxzHeader(badMagic)).toBeNull();
    expect(parseIdxzHeader(buildIdxzHeader(0, 1_000_000, 42))).toBeNull();
    expect(parseIdxzHeader(buildIdxzHeader(IDXZ_BLOCK_SIZE, 0, 42))).toBeNull();
    expect(parseIdxzHeader(buildIdxzHeader(IDXZ_BLOCK_SIZE, 1_000_000, 0))).toBeNull();
  });

  it("parses a valid u16-delta table into prefix sums", async () => {
    const sizes = [100, 200, 50];
    const raw = new Uint8Array(sizes.length * 2);
    const view = new DataView(raw.buffer);
    sizes.forEach((s, i) => view.setUint16(i * 2, s, true));
    const table = await parseIdxzTable(await deflateRaw(raw), sizes.length);
    expect(table && Array.from(table)).toEqual([0, 100, 300, 350]);
  });

  it("rejects a table with the wrong block count", async () => {
    const raw = new Uint8Array(4); // 2 blocks worth
    expect(await parseIdxzTable(await deflateRaw(raw), 3)).toBeNull();
  });

  it("errors (rather than mis-parsing) on garbage deflate data", async () => {
    await expect(
      parseIdxzTable(new Uint8Array([1, 2, 3, 4, 5]), 1),
    ).rejects.toThrow();
  });

  it("rejects headers with implausibly large fields", () => {
    // tableBytes = 4GB-ish would drive a multi-GB dataStart allocation.
    expect(parseIdxzHeader(buildIdxzHeader(IDXZ_BLOCK_SIZE, 1000, 0xffffffff))).toBeNull();
    // blockSize far beyond any real index.
    expect(parseIdxzHeader(buildIdxzHeader(0xffffffff, 1000, 42))).toBeNull();
  });

  it("caps inflateRawBlock output against a decompression bomb", async () => {
    async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
      const s = new Blob([data as BlobPart])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(s).arrayBuffer());
    }
    // 1MB of zeros compresses tiny but inflates large; a 1KB cap must reject.
    const bomb = await deflateRaw(new Uint8Array(1 << 20));
    expect(await inflateRawBlock(bomb, 1024)).toBeNull();
    // Within the cap it returns the bytes.
    const small = await deflateRaw(new Uint8Array(500));
    const out = await inflateRawBlock(small, 1024);
    expect(out?.length).toBe(500);
  });
});

describe("SyncFileSource", () => {
  /** In-memory SyncFileReader that returns deliberately partial reads. */
  function fakeFile(data: Uint8Array, maxPerRead = 7): SyncFileReader {
    return {
      read(buffer: Uint8Array, options: { at: number }): number {
        const at = options.at;
        if (at >= data.length) return 0;
        const n = Math.min(buffer.length, maxPerRead, data.length - at);
        buffer.set(data.subarray(at, at + n));
        return n;
      },
    };
  }

  const data = new Uint8Array(1000);
  for (let i = 0; i < data.length; ++i) data[i] = (i * 37 + 11) & 0xff;

  it("reads bytes and views across chunk boundaries", () => {
    const src = new SyncFileSource(fakeFile(data), data.length, 64);
    src.ensure(0, data.length);
    for (const pos of [0, 1, 63, 64, 65, 500, 999]) {
      expect(src.byte(pos)).toBe(data[pos]);
    }
    const out = new ViewHolder();
    expect(src.view(64, 128, out)).toBe(true); // exactly one chunk
    expect(out.bytes[70 - out.base]).toBe(data[70]);
    expect(src.view(60, 70, out)).toBe(false); // crosses chunks
  });

  it("readInto copies arbitrary ranges despite partial reads", () => {
    const src = new SyncFileSource(fakeFile(data), data.length, 64);
    const target = new Uint8Array(123);
    src.readInto(target, 456);
    expect(Array.from(target)).toEqual(Array.from(data.subarray(456, 456 + 123)));
  });

  it("throws on short reads past the end", () => {
    const src = new SyncFileSource(fakeFile(data), data.length + 10, 64);
    expect(() => src.ensure(data.length, data.length + 10)).toThrow(/short read/);
  });
});

describe("quantifier bounds", () => {
  it("rejects huge lower bounds like huge upper bounds", () => {
    expect(() => compileQuery("a{300}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("a{300,}", ctx)).toThrow(ParseError);
    expect(() => compileQuery("a{100000000,}", ctx)).toThrow(ParseError);
  });

  it("still accepts sane bounds", () => {
    expect(() => compileQuery("a{2,3}", ctx)).not.toThrow();
    expect(() => compileQuery("a{0,}", ctx)).not.toThrow();
    expect(() => compileQuery("a{255}", ctx)).not.toThrow();
  });
});

describe("not-an-index detection", () => {
  it("gives a friendly error for HTML masquerading as an index", async () => {
    const html = new TextEncoder().encode(
      "<!DOCTYPE html><html><body>404 Not Found</body></html>",
    );
    await expect(IndexReader.open(new MemorySource(html))).rejects.toThrow(
      /doesn't look like a Nutrimatic index/,
    );
  });
});
