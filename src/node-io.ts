// Node-only helpers: file-backed sink for IndexWriter, chunk-cached index
// sources for the CLIs, and Nutrimatic-style CLI error reporting.

import * as fs from "node:fs";
import { SyncFileReader, SyncFileSource } from "./byte-source.js";
import { IndexReader } from "./index-reader.js";
import { ByteSink } from "./index-writer.js";

export class FileSink implements ByteSink {
  private readonly fd: number;
  private readonly buf = new Uint8Array(1 << 16);
  private len = 0;

  /** `exclusive` refuses to clobber an existing file (open flag "wx"). */
  constructor(path: string, opts: { exclusive?: boolean } = {}) {
    this.fd = fs.openSync(path, opts.exclusive ? "wx" : "w");
  }

  put(b: number): void {
    if (this.len === this.buf.length) this.flush();
    this.buf[this.len++] = b & 0xff;
  }

  /** Bulk write, bypassing the per-byte buffer. */
  write(data: Uint8Array): void {
    this.flush();
    fs.writeSync(this.fd, data);
  }

  flush(): void {
    if (this.len > 0) {
      fs.writeSync(this.fd, this.buf, 0, this.len);
      this.len = 0;
    }
  }

  close(): void {
    this.flush();
    fs.closeSync(this.fd);
  }
}

class FdReader implements SyncFileReader {
  constructor(private readonly fd: number) {}
  read(buffer: Uint8Array, options: { at: number }): number {
    return fs.readSync(this.fd, buffer, 0, buffer.length, options.at);
  }
  close(): void {
    fs.closeSync(this.fd);
  }
}

/**
 * Open an index file as a chunk-cached ByteSource: multi-GB indexes are read
 * on demand instead of loaded whole, so merge-indexes over dozens of shards
 * never holds every input in RAM at once.
 */
export function openIndexSource(
  path: string,
  maxChunks?: number,
): SyncFileSource {
  const fd = fs.openSync(path, "r");
  return new SyncFileSource(
    new FdReader(fd),
    fs.fstatSync(fd).size,
    undefined,
    maxChunks,
  );
}

/**
 * CLI-friendly index open: prints an Nutrimatic-style one-line error (no stack
 * trace) and exits on unreadable or non-index files.
 */
export async function cliOpenIndex(
  path: string,
  maxChunks?: number,
): Promise<IndexReader> {
  let source: SyncFileSource;
  try {
    source = openIndexSource(path, maxChunks);
  } catch {
    console.error(`error: can't read "${path}"`);
    process.exit(1);
  }
  try {
    return await IndexReader.open(source);
  } catch (e) {
    if (e instanceof Error && e.message.includes("doesn't look like")) {
      console.error(`error: "${path}" is not a Nutrimatic index`);
    } else {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  }
}
