// Fetching with retry, watchdogs, and cancellation — the layer between the
// worker's download paths and the network.
//
// Everything here is written for a flaky mobile connection: a stalled socket
// must fail into a retry rather than hang the UI, a cancel must interrupt a
// transfer mid-body, and a resumed download must not re-fetch bytes it already
// has. Progress is reported through a callback rather than posted directly, so
// this module knows nothing about the page protocol.

import { coveredBytes, rangeCovered } from "./storage.js";

/** Thrown when a transfer is cancelled or superseded, rather than failing. */
export class StopError extends Error {}

// Per-attempt watchdog: a stalled connection must fail into the retry loop
// instead of hanging the UI forever. Generous — this is a stall detector,
// not a latency budget (a 4MB piece on slow mobile can legitimately take
// minutes).
export const FETCH_TIMEOUT = 60_000;
export const PIECE_TIMEOUT = 300_000;

// Full downloads happen in ranged pieces with per-piece retry, so a flaky
// (especially mobile) connection doesn't restart the whole transfer. A few
// pieces stream concurrently to keep the pipe full across RTTs.
export const DOWNLOAD_PIECE = 4 * 1024 * 1024;
export const DOWNLOAD_CONCURRENCY = 4;

export async function retryLoop<T>(
  url: string,
  init: RequestInit | undefined,
  attempts: number,
  timeoutMs: number,
  consume: (resp: Response) => Promise<T>,
): Promise<T> {
  const outer = init?.signal ?? null;
  let lastErr: unknown;
  for (let i = 0; i < attempts; ++i) {
    if (outer?.aborted) throw new StopError("download cancelled");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onOuterAbort = () => ctrl.abort();
    outer?.addEventListener("abort", onOuterAbort);
    try {
      const resp = await fetch(url, { ...init, signal: ctrl.signal });
      if (resp.ok) return await consume(resp);
      lastErr = new Error(`HTTP ${resp.status}`);
      if (resp.status >= 400 && resp.status < 500) break; // no point retrying
    } catch (e) {
      if (outer?.aborted) throw new StopError("download cancelled");
      lastErr = e;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  attempts = 4,
  timeoutMs = FETCH_TIMEOUT,
): Promise<Response> {
  return retryLoop(url, init, attempts, timeoutMs, (resp) =>
    Promise.resolve(resp),
  );
}

/**
 * Like fetchWithRetry but reads the whole body while the watchdog and the
 * cancel relay are still armed — the headers arriving says nothing about the
 * body not stalling, and the body is where the transfer time is. Bulk (piece)
 * downloads must use this so "cancel" interrupts them mid-body.
 */
export async function fetchBytesWithRetry(
  url: string,
  init?: RequestInit,
  attempts = 4,
  timeoutMs = FETCH_TIMEOUT,
): Promise<Uint8Array> {
  return retryLoop(
    url,
    init,
    attempts,
    timeoutMs,
    async (resp) => new Uint8Array(await resp.arrayBuffer()),
  );
}

/**
 * Fetch [0, size) in retried pieces, DOWNLOAD_CONCURRENCY at a time, handing
 * each completed piece to `write(part, offset)` (offset-addressed, so
 * completion order doesn't matter). `onProgress` receives bytes completed.
 */
export async function fetchPieces(
  url: string,
  size: number,
  write: (part: Uint8Array, offset: number) => void,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
  done?: Array<[number, number]>,
  markDone?: (s: number, e: number) => void,
): Promise<void> {
  let nextOffset = 0;
  let loaded = done ? coveredBytes(done) : 0;
  if (loaded > 0) onProgress(loaded);
  const runner = async (): Promise<void> => {
    for (;;) {
      const off = nextOffset;
      if (off >= size) return;
      nextOffset += DOWNLOAD_PIECE;
      const end = Math.min(off + DOWNLOAD_PIECE, size);
      if (done && rangeCovered(done, off, end)) continue; // already downloaded
      const part = await fetchBytesWithRetry(
        url,
        { headers: { Range: `bytes=${off}-${end - 1}` }, signal },
        4,
        PIECE_TIMEOUT,
      );
      if (part.length !== end - off) {
        throw new Error(`short range response (${part.length} bytes at ${off})`);
      }
      write(part, off);
      markDone?.(off, off + part.length);
      loaded += part.length;
      onProgress(loaded);
    }
  };
  await Promise.all(
    Array.from({ length: DOWNLOAD_CONCURRENCY }, () => runner()),
  );
}

export async function openCache(name: string): Promise<Cache | null> {
  try {
    return await caches.open(name);
  } catch {
    return null; // no Cache API (or private mode restrictions): just refetch
  }
}
