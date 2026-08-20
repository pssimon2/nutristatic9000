// The .idxz sidecar: an index file recompressed as independently-deflated
// fixed-size blocks so clients can fetch byte ranges at ~half the transfer
// size. Format 02 layout (all little-endian):
//
//   0..8    magic "nutriz02"
//   8..12   u32 block size (uncompressed bytes per block)
//   12..20  u64 uncompressed index size
//   20..24  u32 compressed table length (ctl)
//   24..24+ctl   raw-deflate of a u16 array: compressed size of each block
//                (offsets are its prefix sums); n = ceil(size / blockSize)
//   then    concatenated raw-deflate blocks
//
// The u16-delta table is ~8x smaller than v01's u64 offsets before its own
// compression (the enwiki table dropped from 340KB to ~45KB on the wire) —
// it is fetched before any search can run, so its size is pure cold-start
// latency. A sidecar is valid for exactly one index file: clients compare
// the header's uncompressed size against the real index's length.

export const IDXZ_MAGIC = "nutriz02";
// 32KB blocks: matches the plain range source's chunk granularity, so the
// per-touched-node waste stays the same and compression is pure savings.
export const IDXZ_BLOCK_SIZE = 1 << 15;
export const IDXZ_HEADER_SIZE = 24;

// Sanity ceilings for a parsed header (defense against crafted sidecars from
// attacker-hosted custom indexes). Generous vs. any real index.
const MAX_BLOCK_SIZE = 1 << 24; // 16MB (real: 32KB)
const MAX_TABLE_BYTES = 32 << 20; // 32MB compressed table (real: <1MB)
const MAX_UNCOMPRESSED_SIZE = 8 * 2 ** 30; // 8GB (download ceiling is 2GB)

export interface IdxzHeader {
  blockSize: number;
  uncompressedSize: number;
  numBlocks: number;
  /** Length of the compressed table section. */
  tableBytes: number;
  /** Byte offset of the block data section within the sidecar file. */
  dataStart: number;
}

export function idxzNumBlocks(size: number, blockSize: number): number {
  return Math.ceil(size / blockSize);
}

export function parseIdxzHeader(bytes: Uint8Array): IdxzHeader | null {
  if (bytes.length < IDXZ_HEADER_SIZE) return null;
  for (let i = 0; i < 8; ++i) {
    if (bytes[i] !== IDXZ_MAGIC.charCodeAt(i)) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockSize = view.getUint32(8, true);
  const uncompressedSize =
    view.getUint32(12, true) + view.getUint32(16, true) * 2 ** 32;
  const tableBytes = view.getUint32(20, true);
  if (!(blockSize > 0) || !(uncompressedSize > 0) || !(tableBytes > 0)) {
    return null;
  }
  // Reject implausible headers up front: a crafted sidecar (attacker-hosted
  // custom index) must not drive a multi-GB allocation from `dataStart` or an
  // absurd block count. These bounds sit far above any real index (a 2GB
  // index at 32KB blocks has a ~128KB raw table) yet cap the blast radius.
  if (
    blockSize > MAX_BLOCK_SIZE ||
    tableBytes > MAX_TABLE_BYTES ||
    uncompressedSize > MAX_UNCOMPRESSED_SIZE
  ) {
    return null;
  }
  const numBlocks = idxzNumBlocks(uncompressedSize, blockSize);
  return {
    blockSize,
    uncompressedSize,
    numBlocks,
    tableBytes,
    dataStart: IDXZ_HEADER_SIZE + tableBytes,
  };
}

export function buildIdxzHeader(
  blockSize: number,
  uncompressedSize: number,
  tableBytes: number,
): Uint8Array {
  const out = new Uint8Array(IDXZ_HEADER_SIZE);
  for (let i = 0; i < 8; ++i) out[i] = IDXZ_MAGIC.charCodeAt(i);
  const view = new DataView(out.buffer);
  view.setUint32(8, blockSize, true);
  view.setUint32(12, uncompressedSize % 2 ** 32, true);
  view.setUint32(16, Math.floor(uncompressedSize / 2 ** 32), true);
  view.setUint32(20, tableBytes, true);
  return out;
}

/**
 * Decompress the table section and return absolute block offsets (relative
 * to the data section): Float64Array of numBlocks+1 entries.
 */
export async function parseIdxzTable(
  compressed: Uint8Array,
  numBlocks: number,
): Promise<Float64Array | null> {
  // The table inflates to exactly numBlocks*2 bytes; cap there so a bomb
  // block can't inflate to gigabytes before the post-hoc length check.
  const raw = await inflateRawBlock(compressed, numBlocks * 2);
  if (raw === null || raw.length !== numBlocks * 2) return null;
  const view = new DataView(raw.buffer, raw.byteOffset);
  const table = new Float64Array(numBlocks + 1);
  for (let i = 0; i < numBlocks; ++i) {
    table[i + 1] = table[i] + view.getUint16(i * 2, true);
  }
  return table;
}

/**
 * Decompress one raw-deflate block. When `maxBytes` is given, inflation is
 * aborted the moment output would exceed it — so a decompression bomb in an
 * attacker-supplied sidecar can't balloon memory before a post-hoc size
 * check (returns null instead). Reads the stream incrementally rather than
 * buffering the whole (attacker-chosen) output first.
 */
export async function inflateRawBlock(
  data: Uint8Array,
  maxBytes?: number,
): Promise<Uint8Array>;
export async function inflateRawBlock(
  data: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array | null>;
export async function inflateRawBlock(
  data: Uint8Array,
  maxBytes?: number,
): Promise<Uint8Array | null> {
  // `new Response(data).body` rather than `new Blob([data]).stream()`: the two
  // produce the same bytes, but the Blob route is 4.8x slower per block in
  // Chromium — 0.29 ms against 0.06 ms for a 32 KB block, measured in the
  // browser. A cold search over the range-mode index inflates on the order of
  // a thousand blocks, so the difference is a quarter of a second of the time
  // to first result, spent constructing Blobs.
  const stream = new Response(data as BodyInit).body!.pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  if (maxBytes === undefined) {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null; // bomb: bail before allocating the full output
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
