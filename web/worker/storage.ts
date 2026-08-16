// OPFS-backed index storage: file names, the completion marker, the
// partial-download progress record, and the range arithmetic both rely on.
//
// Downloaded indexes live in the origin-private filesystem and are read with
// synchronous access handles: instant open (no whole-file load into RAM) and
// near-memory search speed via a small chunk LRU over OS-cached disk reads.
//
// The parsing and range functions here are pure and exported separately from
// the I/O that uses them, so they can be tested without an OPFS: they are the
// part where an off-by-one silently costs a user their 1.3 GB download.

function opfsName(url: string): string {
  return "idx-" + encodeURIComponent(url);
}

// Completion sentinel: pieces are written concurrently at absolute offsets,
// so an interrupted download can leave a full-size file with zeroed holes
// that a size check alone would accept. The marker (containing the size) is
// written only after every piece has landed and been flushed.
function opfsOkName(url: string): string {
  return opfsName(url) + ".ok";
}

function progName(url: string): string {
  return opfsName(url) + ".prog";
}

export { opfsName, opfsOkName, progName };

export interface OpfsMarker {
  size: number;
  validator: string | null;
}

/** Parse a marker file: JSON {size, validator}, or the legacy bare size. */
export function parseOpfsMarker(text: string | null): OpfsMarker | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "number") return { size: parsed, validator: null };
    if (parsed && typeof parsed.size === "number") {
      return { size: parsed.size, validator: parsed.validator ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

// Persisted partial-download progress: which uncompressed byte ranges of the
// index file a prior (interrupted) download already wrote, so the next attempt
// resumes instead of restarting. Ranges are half-open [start, end), kept
// sorted and non-overlapping. Path-independent: whether the bytes arrived via
// the compressed sidecar or plain ranges, a covered range needs no re-fetch.
export interface OpfsProg {
  size: number;
  validator: string | null;
  ranges: Array<[number, number]>;
}

/** Parse a progress record; anything malformed reads as "no progress". */
export function parseOpfsProg(text: string | null): OpfsProg | null {
  if (text === null) return null;
  try {
    const p = JSON.parse(text);
    if (
      p &&
      typeof p.size === "number" &&
      Array.isArray(p.ranges) &&
      p.ranges.every(
        (r: unknown) =>
          Array.isArray(r) &&
          r.length === 2 &&
          typeof r[0] === "number" &&
          typeof r[1] === "number",
      )
    ) {
      return { size: p.size, validator: p.validator ?? null, ranges: p.ranges };
    }
  } catch {
    // corrupt record: treat as no progress
  }
  return null;
}

/** Insert [s, e) into a sorted, non-overlapping range list (mutates in place). */
export function addRange(
  ranges: Array<[number, number]>,
  s: number,
  e: number,
): void {
  if (e <= s) return;
  let i = 0;
  while (i < ranges.length && ranges[i][1] < s) i++;
  let ns = s;
  let ne = e;
  let j = i;
  while (j < ranges.length && ranges[j][0] <= ne) {
    ns = Math.min(ns, ranges[j][0]);
    ne = Math.max(ne, ranges[j][1]);
    j++;
  }
  ranges.splice(i, j - i, [ns, ne]);
}

/** True if [s, e) is fully covered by the sorted, non-overlapping list. */
export function rangeCovered(
  ranges: Array<[number, number]>,
  s: number,
  e: number,
): boolean {
  if (e <= s) return true;
  for (const [rs, re] of ranges) {
    if (rs > s) break;
    if (e <= re) return true;
  }
  return false;
}

export function coveredBytes(ranges: Array<[number, number]>): number {
  let n = 0;
  for (const [s, e] of ranges) n += e - s;
  return n;
}

/**
 * Is a stored record usable for `expected`? A record with no validator, or an
 * index we have no validator for, is accepted: the size check is all we have.
 */
export function validatorOk(
  stored: string | null | undefined,
  current: string | null,
): boolean {
  return stored == null || current == null || stored === current;
}

// ---- OPFS I/O ----

export async function opfsReadMarker(url: string): Promise<string | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opfsOkName(url));
    return await (await handle.getFile()).text();
  } catch {
    return null;
  }
}

export async function opfsReadProg(url: string): Promise<OpfsProg | null> {
  let text: string;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(progName(url));
    text = await (await handle.getFile()).text();
  } catch {
    return null;
  }
  return parseOpfsProg(text);
}

/**
 * Coverage of an unfinished download for this index, or null if there's no
 * resumable partial (finished, absent, or stale). `loaded`/`total` are both
 * uncompressed index bytes, so `loaded / total` is the fraction present.
 */
export async function checkPartial(
  url: string,
  expectedSize: number,
  currentValidator: string | null,
): Promise<{ loaded: number; total: number } | null> {
  const marker = parseOpfsMarker(await opfsReadMarker(url));
  if (
    marker != null &&
    marker.size === expectedSize &&
    validatorOk(marker.validator, currentValidator)
  ) {
    return null; // a finished copy exists
  }
  const prog = await opfsReadProg(url);
  if (
    prog == null ||
    prog.size !== expectedSize ||
    !validatorOk(prog.validator, currentValidator)
  ) {
    return null;
  }
  const loaded = coveredBytes(prog.ranges);
  return loaded > 0 ? { loaded, total: expectedSize } : null;
}

export async function opfsWriteMarker(
  url: string,
  content: string,
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(opfsOkName(url), { create: true });
  const sync = await (handle as any).createSyncAccessHandle();
  try {
    sync.truncate(0);
    sync.write(new TextEncoder().encode(content), { at: 0 });
    sync.flush();
  } finally {
    sync.close();
  }
}

export async function opfsRemove(url: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(opfsName(url)).catch(() => {});
    await root.removeEntry(opfsOkName(url)).catch(() => {});
    await root.removeEntry(progName(url)).catch(() => {});
  } catch {
    // OPFS unavailable
  }
}

export async function opfsHandle(
  url: string,
  create: boolean,
): Promise<FileSystemFileHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getFileHandle(opfsName(url), { create });
  } catch {
    return null; // OPFS unavailable (old browser, private mode, no worker)
  }
}
