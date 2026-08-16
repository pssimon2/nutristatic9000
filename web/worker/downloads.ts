// Getting a whole index onto the device: into OPFS (resumable, the path the
// "download whole index" button drives) or into memory (the small-index and
// no-Range paths).
//
// Everything here reports through a `DownloadReporter` rather than posting
// directly, and takes the index's cache validator as an argument rather than
// reading a module global, so the download paths carry no worker state.

import {
  SyncFileReader,
  SyncFileSource,
} from "../../src/byte-source.js";
import { fetchIdxzPrefix } from "../../src/compressed-source.js";
import { inflateRawBlock } from "../../src/idxz.js";
import {
  DOWNLOAD_CONCURRENCY,
  DOWNLOAD_PIECE,
  PIECE_TIMEOUT,
  StopError,
  fetchBytesWithRetry,
  fetchPieces,
  fetchWithRetry,
  openCache,
} from "./net.js";
import {
  CACHE_NAME,
  VALIDATOR_HEADER,
  cachedCopyStale,
} from "./sources.js";
import {
  addRange,
  coveredBytes,
  opfsHandle,
  opfsOkName,
  opfsReadMarker,
  opfsReadProg,
  opfsRemove,
  opfsWriteMarker,
  parseOpfsMarker,
  progName,
  rangeCovered,
} from "./storage.js";

/** How a download tells the page how far along it is. */
export interface DownloadReporter {
  /** `total` varies by path: plain bytes, or compressed bytes via the sidecar. */
  progress(loaded: number, total: number): void;
  /** The whole copy came straight from the cache. */
  cachedHit(size: number): void;
}

/** Is a stored validator known to contradict the live one? */
function validatorStale(
  stored: string | null | undefined,
  current: string | null,
): boolean {
  return stored != null && current != null && stored !== current;
}

/** Open a previously downloaded index from OPFS, or null. */
export async function openOpfsIndex(
  url: string,
  expectedSize: number,
  currentValidator: string | null,
): Promise<SyncFileSource | null> {
  const handle = await opfsHandle(url, false);
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    const marker = parseOpfsMarker(await opfsReadMarker(url));
    const complete =
      marker != null &&
      marker.size === expectedSize &&
      file.size === expectedSize &&
      !validatorStale(marker.validator, currentValidator);
    if (!complete) {
      // No finished copy. If a matching progress record is present this is a
      // resumable partial — leave the file in place for "resume download".
      // Otherwise it's stale (the index was replaced on the server — caught by
      // size, or by the ETag/Last-Modified validator on a same-size rebuild)
      // or corrupt, so reclaim the space.
      const prog = await opfsReadProg(url);
      const resumable =
        prog != null &&
        prog.size === expectedSize &&
        !validatorStale(prog.validator, currentValidator) &&
        coveredBytes(prog.ranges) > 0;
      if (!resumable) await opfsRemove(url);
      return null;
    }
    // The previous page's worker may not have released its lock yet right
    // after a reload: retry briefly before giving up.
    for (let attempt = 0; ; ++attempt) {
      try {
        const sync = await (handle as any).createSyncAccessHandle();
        return new SyncFileSource(sync as SyncFileReader, expectedSize);
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  } catch {
    return null; // locked by another tab, or sync handles unsupported
  }
}

/** Download the index into OPFS (retried pieces); null if OPFS unavailable. */
export async function downloadToOpfs(
  url: string,
  size: number,
  currentValidator: string | null,
  report: DownloadReporter,
  signal?: AbortSignal,
): Promise<SyncFileSource | null> {
  const handle = await opfsHandle(url, true);
  if (!handle) return null;
  let sync: any;
  try {
    sync = await (handle as any).createSyncAccessHandle();
  } catch {
    return null;
  }
  const validator = currentValidator ?? null;
  let progSync: any = null;
  try {
    const root = await navigator.storage.getDirectory();
    // Invalidate any previous completion marker before touching the file
    // (the file itself stays: we hold its open handle).
    await root.removeEntry(opfsOkName(url)).catch(() => {});

    // Resume a prior interrupted download when its progress record still
    // matches this exact index; otherwise start from an empty file. Read the
    // record before opening a write handle on it (a handle would lock it).
    const prior = await opfsReadProg(url);
    const ranges: Array<[number, number]> =
      prior && prior.size === size && prior.validator === validator
        ? prior.ranges
        : [];
    if (ranges.length === 0) sync.truncate(0);

    // Keep one handle open on the progress record for the whole download and
    // rewrite it (it's tiny) after each completed piece, so a network drop or
    // cancel leaves an accurate resume point behind. Best-effort: if the
    // record can't be opened, the download still runs, just not resumably.
    try {
      const progHandle = await root.getFileHandle(progName(url), { create: true });
      progSync = await (progHandle as any).createSyncAccessHandle();
    } catch {
      progSync = null;
    }

    const enc = new TextEncoder();
    const persist = (): void => {
      if (!progSync) return;
      try {
        const json = enc.encode(JSON.stringify({ size, validator, ranges }));
        progSync.truncate(0);
        progSync.write(json, { at: 0 });
        progSync.flush();
      } catch {
        // The progress record turned out to be unwritable (a platform quirk
        // around a second open sync handle, say): abandon resume support for
        // this download rather than letting it sink the whole transfer.
        try {
          progSync.close();
        } catch {
          // best-effort
        }
        progSync = null;
      }
    };
    persist();
    const markDone = progSync
      ? (s: number, e: number): void => {
          addRange(ranges, s, e);
          persist();
        }
      : undefined;
    const done = progSync ? ranges : undefined;
    const write = (part: Uint8Array, off: number) => sync.write(part, { at: off });

    const viaZ = await downloadViaSidecar(
      url,
      size,
      write,
      report,
      signal,
      done,
      markDone,
    );
    if (!viaZ) {
      await fetchPieces(
        url,
        size,
        write,
        (loaded) => report.progress(loaded, size),
        signal,
        done,
        markDone,
      );
    }
    sync.flush();
    // Optional chaining, not a bare call: `persist` nulls progSync when the
    // record turns out to be unwritable, and the open can fail outright. A
    // bare `.close()` threw here on exactly those platforms — after a fully
    // successful transfer — so the completion marker was never written and
    // the whole index was re-downloaded on the next visit.
    progSync?.close();
    progSync = null;
    await root.removeEntry(progName(url)).catch(() => {});
    await opfsWriteMarker(url, JSON.stringify({ size, validator }));
    return new SyncFileSource(sync as SyncFileReader, size);
  } catch (e) {
    // Keep the partial file and its progress record so the next attempt
    // resumes; just release the handles.
    try {
      progSync?.close();
    } catch {
      // best-effort
    }
    try {
      sync.close();
    } catch {
      // best-effort
    }
    throw e;
  }
}

/**
 * Whole-index download via the .idxz sidecar (~half the transfer), writing
 * decompressed blocks through `write`. Returns false if there is no valid
 * sidecar (caller falls back to plain ranges; on partial failure the plain
 * path rewrites every offset, so no torn state survives).
 */
export async function downloadViaSidecar(
  url: string,
  size: number,
  write: (part: Uint8Array, offset: number) => void,
  report: DownloadReporter,
  signal?: AbortSignal,
  done?: Array<[number, number]>,
  markDone?: (s: number, e: number) => void,
): Promise<boolean> {
  const sidecarUrl = url + ".idxz";
  try {
    // Shared with CompressedRangeSource.open: fetch + validate header/table.
    const pre = await fetchIdxzPrefix(sidecarUrl, size, ((input, init) =>
      fetchWithRetry(String(input), { ...init, signal })) as typeof fetch);
    if (signal?.aborted) throw new StopError("download cancelled");
    if (!pre) return false;
    const { header, table } = pre;

    // Group blocks into ~piece-sized compressed spans.
    const spans: Array<[number, number]> = [];
    let spanStart = 0;
    for (let b = 1; b <= header.numBlocks; ++b) {
      if (table[b] - table[spanStart] >= DOWNLOAD_PIECE || b === header.numBlocks) {
        spans.push([spanStart, b]);
        spanStart = b;
      }
    }

    const totalComp = table[header.numBlocks];
    const bs = header.blockSize;
    const spanRange = (s: number, e: number): [number, number] => [
      s * bs,
      Math.min(e * bs, size),
    ];
    let nextSpan = 0;
    let loaded = 0;
    if (done) {
      // Count the compressed bytes of spans a prior attempt already wrote, so
      // the progress bar resumes at the right point.
      for (const [s, e] of spans) {
        const [uStart, uEnd] = spanRange(s, e);
        if (rangeCovered(done, uStart, uEnd)) loaded += table[e] - table[s];
      }
      if (loaded > 0) report.progress(loaded, totalComp);
    }
    const runner = async (): Promise<void> => {
      for (;;) {
        const idx = nextSpan++;
        if (idx >= spans.length) return;
        const [s, e] = spans[idx];
        const [uStart, uEnd] = spanRange(s, e);
        if (done && rangeCovered(done, uStart, uEnd)) continue; // already have it
        const from = header.dataStart + table[s];
        const to = header.dataStart + table[e] - 1;
        const buf = await fetchBytesWithRetry(
          sidecarUrl,
          { headers: { Range: `bytes=${from}-${to}` }, signal },
          4,
          PIECE_TIMEOUT,
        );
        if (buf.length !== to - from + 1) throw new Error("idxz short span");
        const jobs: Promise<void>[] = [];
        for (let b = s; b < e; ++b) {
          const off = table[b] - table[s];
          const len = table[b + 1] - table[b];
          jobs.push(
            inflateRawBlock(buf.subarray(off, off + len), header.blockSize).then((data) => {
              const expected = Math.min(header.blockSize, size - b * header.blockSize);
              if (data === null || data.length !== expected) {
                throw new Error(`idxz bad block ${b}`);
              }
              write(data, b * header.blockSize);
            }),
          );
        }
        await Promise.all(jobs);
        markDone?.(uStart, uEnd);
        loaded += buf.length;
        report.progress(loaded, totalComp);
      }
    };
    await Promise.all(
      Array.from({ length: DOWNLOAD_CONCURRENCY }, () => runner()),
    );
    return true;
  } catch (e) {
    // A cancel must propagate; only genuine sidecar trouble falls back to
    // plain ranges.
    if (signal?.aborted) throw e;
    return false;
  }
}

export async function downloadWhole(
  url: string,
  size: number,
  ranged: boolean,
  currentValidator: string | null,
  report: DownloadReporter,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const cache = await openCache(CACHE_NAME);
  if (cache) {
    const hit = await cache.match(url);
    if (hit && cachedCopyStale(hit, currentValidator)) {
      await cache.delete(url); // same-size rebuild caught by the validator
    } else if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      if (buf.length === size) {
        report.cachedHit(size);
        return buf;
      }
      await cache.delete(url); // stale (index was replaced): refetch
    }
  }

  const data = new Uint8Array(size);
  if (ranged) {
    const viaZ = await downloadViaSidecar(
      url,
      size,
      (part, off) => data.set(part, off),
      report,
      signal,
    );
    if (!viaZ) {
      await fetchPieces(
        url,
        size,
        (part, off) => data.set(part, off),
        (loaded) => report.progress(loaded, size),
        signal,
      );
    }
  } else {
    // No Range support: stream the body so progress still moves, with a
    // stall watchdog (reset on every received chunk) and cancel relay —
    // this single response IS the whole transfer.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    let stallTimer = setTimeout(() => ctrl.abort(), PIECE_TIMEOUT);
    try {
      const resp = await fetchWithRetry(url, { signal: ctrl.signal });
      let loaded = 0;
      let lastPosted = 0;
      if (resp.body) {
        const bodyReader = resp.body.getReader();
        for (;;) {
          const { done, value } = await bodyReader.read();
          if (done) break;
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => ctrl.abort(), PIECE_TIMEOUT);
          if (loaded + value.length > size) {
            throw new Error(`long response (over ${size} bytes)`);
          }
          data.set(value, loaded);
          loaded += value.length;
          if (loaded - lastPosted >= 2 * 1024 * 1024 || loaded === size) {
            lastPosted = loaded;
            report.progress(loaded, size);
          }
        }
      } else {
        const buf = new Uint8Array(await resp.arrayBuffer());
        data.set(buf.subarray(0, Math.min(buf.length, size)));
        loaded = buf.length;
      }
      if (loaded !== size) {
        throw new Error(`short response (${loaded} of ${size} bytes)`);
      }
    } catch (e) {
      if (signal?.aborted) throw new StopError("download cancelled");
      throw e;
    } finally {
      clearTimeout(stallTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  if (cache) {
    try {
      // No defensive copy: `data` is never mutated afterwards, and doubling
      // a multi-hundred-MB allocation is the bigger risk.
      await cache.put(
        url,
        new Response(data, {
          headers: currentValidator
            ? { [VALIDATOR_HEADER]: currentValidator }
            : {},
        }),
      );
    } catch {
      // Quota exceeded etc. — caching is best-effort.
    }
  }
  return data;
}
