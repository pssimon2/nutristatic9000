// Search worker: owns the index and the search session so the UI thread
// stays responsive. The index is fetched fully into memory when small;
// larger indexes are read lazily with HTTP Range requests, so even a
// multi-gigabyte index needs nothing but static file hosting.

import {
  HttpRangeSource,
  MemorySource,
  SyncFileSource,
} from "../src/byte-source.js";
import { CompressedRangeSource } from "../src/compressed-source.js";
import { FileRangeSource } from "../src/file-source.js";
import { IndexReader } from "../src/index-reader.js";
import { makeWordChecker } from "../src/index-words.js";
import type { WordCheck } from "../src/compound.js";
import { needsPhonetics, parsePhonetics } from "../src/phonetics.js";
import { needsThesaurus, parseThesaurus } from "../src/thesaurus.js";
import {
  needsStress,
  parseStress,
} from "../src/stress.js";
import { needsCategories, parseCategories } from "../src/categories.js";
import {
  nearestTo,
  needsNeighbours,
  parseNeighbours,
} from "../src/neighbours.js";
import { DataKey, SessionContext } from "../src/session-context.js";
import { applyResultFilters, nearOrderKey } from "../src/result-predicate.js";
import { needsWikiLists, parseWikiLists } from "../src/word-lists.js";
import { shapeOfQuery } from "../src/query-shape.js";
import { explainMatch } from "../src/explain.js";
import { formatPlan, planQuery } from "../src/plan.js";
import type { InMsg, OpenMsg } from "./worker/protocol.js";
import {
  DownloadReporter,
  downloadToOpfs,
  downloadWhole,
  openOpfsIndex,
} from "./worker/downloads.js";
import {
  CACHE_NAME,
  CHUNK_CACHE_NAME,
  CacheChunkStore,
  RANGE_CHUNK_SIZE,
  cachedCopyStale,
  parseEarlyProbe,
} from "./worker/sources.js";
import {
  StopError,
  fetchWithRetry,
  openCache,
} from "./worker/net.js";
import {
  checkPartial,
  opfsReadMarker,
  opfsRemove,
  parseOpfsMarker,
} from "./worker/storage.js";
// letters() shares the space-dropping rule with the filters below.
import {
  FilterError,
  type FilterSpec,
  parseFilterWrappers,
} from "../src/result-filter.js";
import { compileQuery } from "../src/find-expr.js";
import { ParseError } from "../src/parse-error.js";
import {
  ExtractError,
  parseExtract,
  parseRank,
} from "../src/extract-spec.js";
import { SearchSession } from "../src/search-session.js";
import {
  WasmCapacityError,
  WasmEngine,
  WasmSession,
  WasmUnsupportedError,
} from "../src/wasm-session.js";
import kernelUrl from "../wasm-kernel/kernel.wasm?url";

// Indexes up to this size are simply downloaded; everything bigger defaults
// to Range mode (fetch only what a query touches) unless a full copy is
// already in the browser cache. The user can explicitly download the whole
// index ("download-full") for offline/faster searching.
const TINY_LIMIT = 4 * 1024 * 1024;
// Absolute ceiling for whole-index downloads: covers the 1.3GB Wikipedia
// index — a one-time download into the browser cache buys memory-speed
// searches, so a heavy anagram that is slow to stream returns in well under
// a second.
const FULL_DOWNLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
// Range mode: prewarm this much of the file tail (trie root region), and
// keep this many parallel prefetches going during a search. The prewarm is
// deliberately small and non-blocking: on slow links upfront bytes delay the
// first result, which is the metric that matters.
const PREWARM_BYTES = 128 * 1024;
// Broad searches (anagrams especially) have wide frontiers: deep speculative
// prefetch turns serial fetch stalls into parallel transfers.
const PREFETCH_DEPTH = 48;


let reader: IndexReader | null = null;
let rangeSource:
  | HttpRangeSource
  | CompressedRangeSource
  | FileRangeSource
  | null = null;
let diskSource: SyncFileSource | null = null;
let session: SearchSession | WasmSession | null = null;
let runToken = 0; // bumped to cancel an in-flight run
let currentUrl: string | null = null;
let currentSize = 0;
let currentValidator: string | null = null; // ETag/Last-Modified from probe

// ---- WASM engine ----
// Used when the whole index is locally available: memory mode always, disk
// (OPFS) mode up to this size — the kernel needs the index in linear memory,
// so range mode (async fetches mid-search) stays on the JS engine. Any WASM
// failure falls back to JS; both engines emit identical score-streams.
const WASM_INDEX_LIMIT = 800 * 1024 * 1024;
let wasmModule: Promise<WebAssembly.Module> | null = null;
// Single-flight per index: a second search racing the first engine creation
// must await the SAME instance, not build a second full index copy.
let wasmEngine: Promise<WasmEngine> | null = null;
let wasmBroken = false; // this environment can't run the kernel: stop trying
let memBytes: Uint8Array | null = null; // index bytes when in memory mode
let currentQuery: string | null = null;
let emitted = new Set<string>(); // texts posted for the current query
// Steps already executed on an engine that was discarded mid-search (the WASM
// kernel overflowing its frontier cap and replaying on the JS engine). Added
// to the live session's steps so the progress counter never jumps backwards.
// Reset when a new query starts; carried across "continue" runs of one query.
let searchStepBase = 0;
// `{compound N:…}`: results must cut into N words the index knows. Verified
// here rather than in the automaton, because "is this a word" is a question
// only the index can answer.
let resultFilters: FilterSpec[] = [];
// When a query asks for words near another, the neighbour list is already in
// order of closeness — so results should come back that way rather than in
// corpus-frequency order, which buries the best answer under the commonest.
let nearOrder: Map<string, number> | null = null;
let wordChecker: WordCheck | null = null;
// The pronouncing dictionary is ~400 KB over the wire and only some queries
// need it, so it is fetched the first time one does and kept thereafter.
const extraLoads = new Map<string, Promise<void>>();

/**
 * The side data this worker's queries compile against. One worker is one
 * session, so one context: the engine itself holds no dataset state, which is
 * what lets several workers hold different data (sharding, multi-index).
 */
const ctx = new SessionContext();

/**
 * Fetch a side dataset once and store it on the context. Kept out of the
 * bundle because most queries never need it; kept in memory once fetched
 * because a solver who rhymes once will rhyme again. Keying readiness and
 * caching on the same `DataKey` means the two can no longer disagree.
 */
async function ensureExtra(
  key: DataKey,
  url: string | null,
  install: (response: Response) => Promise<void>,
): Promise<void> {
  if (ctx[key] !== null || !url) return;
  let load = extraLoads.get(key);
  if (!load) {
    load = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await install(r);
    })().catch((e) => {
      extraLoads.delete(key); // let a later query try again
      throw e;
    });
    extraLoads.set(key, load);
  }
  await load;
}

/**
 * The index-backed word predicate, rebuilt whenever the index changes.
 *
 * Typed as `WordCheck` rather than spelled out, so it cannot quietly stop
 * forwarding an argument the checker grew. It did exactly that once: the
 * frequency floor that tells a word from corpus debris arrived as a second
 * parameter, this adapter still took one, and TypeScript accepts a
 * shorter-arity function for a longer signature — so `{compound}` and
 * `{reversible}` went on answering "is it present" in the browser while the
 * tests, which call the checker directly, saw the fix.
 */
const isIndexedWord: WordCheck = (word, minShare) => {
  if (!reader) return false;
  wordChecker ??= makeWordChecker(reader);
  return wordChecker(word, minShare);
};

function getWasmModule(): Promise<WebAssembly.Module> {
  // fetch + compile (not instantiateStreaming): no reliance on the server
  // sending application/wasm.
  wasmModule ??= fetch(kernelUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`kernel fetch: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((b) => WebAssembly.compile(b));
  return wasmModule;
}

function getWasmEngine(): Promise<WasmEngine> {
  if (wasmEngine) return wasmEngine;
  const p: Promise<WasmEngine> = (async () => {
    const module = await getWasmModule();
    const total = reader!.count();
    if (memBytes) {
      const data = memBytes;
      return WasmEngine.create(module, data.length, total, (t) => t.set(data));
    }
    if (diskSource) {
      const disk = diskSource;
      return WasmEngine.create(module, currentSize, total, (t) => {
        const SLICE = 8 * 1024 * 1024;
        for (let off = 0; off < t.length; off += SLICE) {
          disk.readInto(t.subarray(off, Math.min(off + SLICE, t.length)), off);
        }
      });
    }
    throw new Error("index not fully local");
  })().catch((e) => {
    // Un-cache the failure — but only if a newer open hasn't already
    // replaced the slot with its own in-flight creation.
    if (wasmEngine === p) wasmEngine = null;
    throw e;
  });
  wasmEngine = p;
  return p;
}

const post = (msg: unknown) => postMessage(msg);

// Last "ready" payload: re-posted to restore the UI when an explicit
// download fails but the previously loaded index is still usable.
let lastReady: unknown = null;
const postReady = (msg: unknown) => {
  lastReady = msg;
  post(msg);
};

// Reclaim storage from obsolete cache versions (best-effort, async).
// Fully optional-chained: `caches` is absent over file:// (offline build) and
// in browsers without the Cache API — a bare reference or an un-guarded
// `.catch` would throw at module evaluation and kill the worker.
void globalThis.caches?.delete("nutrimatic-chunks-v1")?.catch(() => {});

// Macrotask yield that lets queued messages (stop/continue) be processed.
// Deliberately NOT setTimeout: browsers clamp timers in background pages to
// ~1s, which turned a 1M-step search into ~50 seconds of sleeping when the
// tab wasn't focused. MessageChannel posts are never throttled.
const yieldChannel = new MessageChannel();
// A Set, not a single slot: two runs can be parked at once (a superseded run
// awaiting its yield while its successor starts). Waking ALL of them lets a
// stale run reach its token check and unwind (releasing runsActive) instead
// of staying suspended forever.
const yieldResolvers = new Set<() => void>();
yieldChannel.port1.onmessage = () => {
  const pending = [...yieldResolvers];
  yieldResolvers.clear();
  for (const r of pending) r();
};
function macroYield(): Promise<void> {
  return new Promise((resolve) => {
    yieldResolvers.add(resolve);
    yieldChannel.port2.postMessage(0);
  });
}

/** Named-cache open, defaulting to the whole-index cache. */
const openCacheNamed = (name = CACHE_NAME) => openCache(name);

/** How the download paths report back to the page. */
const report: DownloadReporter = {
  progress: (loaded, total) =>
    post({ type: "loading", mode: "download", bytes: total, loaded }),
  cachedHit: (size) =>
    post({ type: "loading", mode: "download", bytes: size, loaded: size, cached: true }),
};

const retryFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  fetchWithRetry(String(input), init)) as typeof fetch;

async function useMemory(
  data: Uint8Array,
  cached: boolean,
  stillValid: () => boolean = () => true,
): Promise<void> {
  const r = await IndexReader.open(new MemorySource(data));
  if (!stillValid()) return; // superseded by a newer open
  reader = r;
  rangeSource = null;
  session = null;
  memBytes = data;
  wasmEngine = null; // rebuilt lazily from the new bytes
  postReady({
    type: "ready",
    bytes: data.length,
    mode: "memory",
    cached,
    total: reader.count(),
  });
}

// Generation counter: overlapping open/download-full operations (double
// "Retry" clicks, an open racing a download) must not interleave their state
// assignment — only the newest generation may touch globals or post.
let openGen = 0;

/**
 * Open a completed device (OPFS) copy with NO network, using the size stored
 * in its completion marker. Used offline, when the index can't be probed over
 * the network. Returns the source + the marker's size/validator, or null if
 * there is no usable complete copy.
 */
async function openOpfsOffline(
  url: string,
): Promise<{ source: SyncFileSource; size: number; validator: string | null } | null> {
  const marker = parseOpfsMarker(await opfsReadMarker(url));
  if (!marker || typeof marker.size !== "number") return null;
  // Adopt the marker's validator so openOpfsIndex's staleness check (which
  // would otherwise compare against the unreachable server) is a no-op.
  currentValidator = marker.validator;
  const source = await openOpfsIndex(url, marker.size, currentValidator);
  if (!source) return null;
  return { source, size: marker.size, validator: marker.validator };
}

/**
 * List the index URLs that have a complete device (OPFS) copy — i.e. the ones
 * searchable fully offline. Enumerates the `.ok` completion markers and keeps
 * those whose index file matches the marker's stored size.
 */
async function listOpfsCopies(): Promise<string[]> {
  const urls: string[] = [];
  try {
    const root = await navigator.storage.getDirectory();
    const markers: string[] = [];
    for await (const name of (root as any).keys() as AsyncIterable<string>) {
      if (name.startsWith("idx-") && name.endsWith(".ok")) markers.push(name);
    }
    for (const markerName of markers) {
      const base = markerName.slice(0, -".ok".length); // idx-<encoded url>
      let url: string;
      try {
        url = decodeURIComponent(base.slice("idx-".length));
      } catch {
        continue;
      }
      try {
        const mk = parseOpfsMarker(await opfsReadMarker(url));
        if (!mk || typeof mk.size !== "number") continue;
        const fh = await root.getFileHandle(base).catch(() => null);
        if (!fh) continue;
        if ((await fh.getFile()).size === mk.size) urls.push(url);
      } catch {
        // skip an unreadable entry
      }
    }
  } catch {
    // OPFS unavailable
  }
  return urls;
}

async function openIndex(url: string, early?: OpenMsg["early"]): Promise<void> {
  const gen = ++openGen;
  const stale = () => gen !== openGen;
  reader = null;
  wordChecker = null; // bound to the old index
  rangeSource = null;
  diskSource?.close(); // release the OPFS lock before (re)opening anything
  diskSource = null;
  session = null;
  memBytes = null;
  wasmEngine = null; // dropping the instance frees its linear memory
  currentUrl = url;
  let probe = early?.probe ? parseEarlyProbe(early.probe) : null;
  if (!probe) {
    // Offline path: a completed device copy opens with no network at all. Try
    // it first when the browser reports itself offline, and as a fallback if
    // the network probe fails (server unreachable) with a copy on hand.
    let off =
      typeof navigator !== "undefined" && navigator.onLine === false
        ? await openOpfsOffline(url)
        : null;
    if (!off) {
      try {
        const p = await HttpRangeSource.open(url, { fetchFn: retryFetch });
        probe = {
          length: p.length,
          supportsRanges: p.supportsRanges,
          validator: p.validator,
        };
      } catch (e) {
        off = await openOpfsOffline(url);
        if (!off) throw e; // no offline copy: surface the network error
      }
    }
    if (off) {
      if (stale()) {
        off.source.close();
        return;
      }
      currentSize = off.size;
      currentValidator = off.validator;
      const r = await IndexReader.open(off.source);
      if (stale()) {
        off.source.close();
        return;
      }
      diskSource = off.source;
      reader = r;
      postReady({
        type: "ready",
        bytes: off.size,
        mode: "disk",
        cached: true,
        total: r.count(),
      });
      return;
    }
  }
  if (stale()) return;
  // Unreachable: with no early probe we either set `probe` above or returned
  // via the offline copy. Narrows the type and guards future refactors.
  if (!probe) throw new Error("index unavailable");
  currentSize = probe.length;
  currentValidator = probe.validator;

  // A changed validator with an unchanged size means the index was rebuilt:
  // persisted range chunks (and the sidecar table) would silently serve
  // stale bytes. Purge them before any source touches the store.
  if (probe.validator) {
    try {
      const cache = await openCacheNamed(CHUNK_CACHE_NAME);
      const key = `${url}?nutrimatic-validator`;
      const prev = cache && (await cache.match(key));
      const prevVal = prev ? await prev.text() : null;
      if (stale()) return;
      if (prevVal !== probe.validator) {
        if (prevVal !== null) await purgeChunks(url);
        await cache?.put(key, new Response(probe.validator));
      }
    } catch {
      // validation is best-effort
    }
    if (stale()) return;
  }

  // An OPFS copy opens instantly: sync disk reads, no RAM load.
  const disk = await openOpfsIndex(url, probe.length, currentValidator);
  if (stale()) {
    disk?.close(); // don't hold the lock the newer open needs
    return;
  }
  if (disk) {
    const r = await IndexReader.open(disk);
    if (stale()) {
      disk.close();
      return;
    }
    diskSource = disk;
    reader = r;
    postReady({
      type: "ready",
      bytes: probe.length,
      mode: "disk",
      cached: true,
      total: r.count(),
    });
    return;
  }

  // A previously downloaded full copy means zero network traffic.
  const cache = await openCacheNamed();
  const hit = cache && (await cache.match(url));
  if (hit && cachedCopyStale(hit, currentValidator)) {
    await cache!.delete(url); // same-size rebuild caught by the validator
    if (stale()) return;
  } else if (hit) {
    const data = new Uint8Array(await hit.arrayBuffer());
    if (stale()) return;
    if (data.length === probe.length) {
      await useMemory(data, true, () => !stale());
      return;
    }
    await cache.delete(url); // index changed on the server: start over
    if (stale()) return;
  }

  if (probe.length <= TINY_LIMIT || !probe.supportsRanges) {
    // Automatic downloads stay small; only the explicit "download whole
    // index" button may pull gigabytes.
    if (probe.length > 256 * 1024 * 1024) {
      throw new Error(
        `index is ${Math.round(probe.length / 1048576)} MB and its server ` +
          `does not support Range requests`,
      );
    }
    post({ type: "loading", bytes: probe.length, loaded: 0, mode: "download" });
    const data = await downloadWhole(
      url,
      probe.length,
      probe.supportsRanges,
      currentValidator,
      report,
    );
    if (stale()) return;
    await useMemory(data, false, () => !stale());
  } else {
    // Default for big indexes: fetch only what queries touch, and remember
    // those pieces across visits. A .idxz sidecar (if published next to the
    // index) roughly halves the bytes on the wire.
    post({ type: "loading", bytes: probe.length, mode: "range" });
    const src =
      (await CompressedRangeSource.open(url, probe.length, {
        fetchFn: retryFetch,
        prefixBytes: early?.table ? new Uint8Array(early.table) : undefined,
        makeStore: (blockSize) => new CacheChunkStore(url + ".idxz", blockSize),
        tableStore: {
          get: async () => {
            const cache = await openCacheNamed(CHUNK_CACHE_NAME);
            const hit = cache && (await cache.match(`${url}?nutrimatic-idxz-table`));
            return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
          },
          put: (data) => {
            void openCacheNamed(CHUNK_CACHE_NAME)
              .then((c) => c?.put(`${url}?nutrimatic-idxz-table`, new Response(data as BodyInit)))
              .catch(() => {});
          },
        },
      })) ??
      (await HttpRangeSource.open(url, {
        fetchFn: retryFetch,
        known: probe,
        chunkStore: new CacheChunkStore(url, RANGE_CHUNK_SIZE),
        // Smaller chunks waste fewer bytes per touched trie node (~4KB
        // spans); the prefetch parallelism hides the per-request latency.
        chunkSize: RANGE_CHUNK_SIZE,
        maxChunks: 4096,
      }));
    if (stale()) return;
    // Prewarm the trie root region (the file tail) in the background: every
    // query starts there. Not awaited — the first search's own fetches
    // dedupe against it and win the bandwidth race.
    const prewarm = src.ensure(
      Math.max(0, probe.length - PREWARM_BYTES),
      probe.length,
    );
    if (prewarm) prewarm.catch(() => {});
    const r = await IndexReader.open(src);
    if (stale()) return;
    const partial = await checkPartial(url, probe.length, currentValidator);
    if (stale()) return;
    rangeSource = src;
    reader = r;
    postReady({
      type: "ready",
      bytes: probe.length,
      mode: "range",
      total: r.count(),
      // What "download whole index" would actually transfer: the compressed
      // sidecar when one exists, the raw index otherwise.
      downloadBytes:
        src instanceof CompressedRangeSource
          ? src.compressedSize
          : probe.length,
      // A previously interrupted whole-index download that can be resumed.
      partial: partial ?? undefined,
    });
  }
}

/**
 * Offline mode: open an index from a user-picked local File. Reads on demand
 * with File.slice() (no server, no whole-file load), reusing the whole search
 * pipeline. The JS engine handles it (no memBytes/diskSource set), which is
 * exactly what we want with no network cost to avoid.
 */
async function openFile(file: Blob): Promise<void> {
  const gen = ++openGen;
  diskSource?.close();
  diskSource = null;
  rangeSource = null;
  reader = null;
  session = null;
  memBytes = null;
  wasmEngine = null;
  currentUrl = null;
  currentValidator = null;
  currentSize = file.size;
  const src = new FileRangeSource(file);
  const r = await IndexReader.open(src);
  if (gen !== openGen) return;
  rangeSource = src;
  reader = r;
  postReady({ type: "ready", bytes: file.size, mode: "local", total: r.count() });
}

// In-flight explicit download, abortable via the "cancel-download" message.
let downloadCtrl: AbortController | null = null;

/** Drop persisted range chunks + sidecar table for `url` (superseded by a
 * full local copy). Keys cover both the plain and `.idxz` chunk stores. */
async function purgeChunks(url: string): Promise<void> {
  try {
    const cache = await openCacheNamed(CHUNK_CACHE_NAME);
    if (!cache) return;
    // Keys are `${url}?nutrimatic-...` (plain store, validator, table) and
    // `${url}.idxz?nutrimatic-chunk=...` (compressed store). Matching those
    // two exact prefixes — rather than a bare `startsWith(url)` — avoids
    // also purging a different index whose URL merely starts with this one.
    for (const req of await cache.keys()) {
      if (
        req.url.startsWith(url + "?") ||
        req.url.startsWith(url + ".idxz?")
      ) {
        await cache.delete(req);
      }
    }
  } catch {
    // best-effort
  }
}

async function downloadFull(): Promise<void> {
  if (!currentUrl) throw new Error("no index loaded");
  if (downloadCtrl) throw new Error("a download is already in progress");
  if (currentSize > FULL_DOWNLOAD_LIMIT) {
    throw new Error("index too large to download whole");
  }
  // Fail fast on insufficient storage instead of minutes into the transfer.
  try {
    const est = await navigator.storage.estimate();
    if (
      est.quota != null &&
      est.usage != null &&
      currentSize > est.quota - est.usage
    ) {
      const free = Math.max(0, est.quota - est.usage);
      throw new Error(
        `not enough storage (need ${Math.round(currentSize / 1048576)} MB, ` +
          `~${Math.round(free / 1048576)} MB free)`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("not enough")) throw e;
    // estimate() unavailable: proceed and let the write fail if it must.
  }
  // Ask the browser not to evict gigabytes of index behind the user's back.
  void navigator.storage.persist?.().catch(() => {});

  downloadCtrl = new AbortController();
  const signal = downloadCtrl.signal;
  const gen = openGen; // a newer open supersedes this download's results
  // Show the actual transfer size up front (the compressed sidecar when one
  // exists), so the progress denominator doesn't jump from uncompressed to
  // compressed once the first chunk lands.
  const initialTotal =
    rangeSource instanceof CompressedRangeSource
      ? rangeSource.compressedSize
      : currentSize;
  post({ type: "loading", bytes: initialTotal, loaded: 0, mode: "download" });
  try {
    const disk = await downloadToOpfs(
      currentUrl,
      currentSize,
      currentValidator,
      report,
      signal,
    );
    if (gen !== openGen) {
      disk?.close();
      return;
    }
    if (disk) {
      diskSource = disk;
      reader = await IndexReader.open(disk);
      rangeSource = null;
      session = null;
      wasmEngine = null; // rebuild from the disk copy on next search
      // The full copy supersedes the Cache Storage copy AND any persisted
      // range chunks for this index: free the quota.
      void openCacheNamed().then((c) => c?.delete(currentUrl!)).catch(() => {});
      void purgeChunks(currentUrl);
      postReady({
        type: "ready",
        bytes: currentSize,
        mode: "disk",
        cached: false,
        total: reader.count(),
      });
      return;
    }

    // OPFS unavailable: fall back to the in-memory + Cache Storage path —
    // but never try to hold a gigabyte-class index in RAM.
    if (currentSize > 512 * 1024 * 1024) {
      throw new Error(
        "device storage unavailable and the index is too large to hold in memory",
      );
    }
    const data = await downloadWhole(
      currentUrl,
      currentSize,
      true,
      currentValidator,
      report,
      signal,
    );
    if (gen !== openGen) return;
    await useMemory(data, false, () => gen === openGen);
    void purgeChunks(currentUrl);
  } finally {
    downloadCtrl = null;
  }
}

// The session a live run is stepping, if any. Two runs on the SAME session
// would corrupt the shared driver scratch state, so a continue targeting it
// is dropped. Runs of REPLACED sessions don't block anything: they unwind at
// their next yield, and their private state can't corrupt the new session.
let activeRunSession: SearchSession | WasmSession | null = null;

async function runSession(
  maxSteps: number,
  maxResults: number,
  byteBudget: number,
  timeMs: number,
  // The search handler captures its token at message receipt, so a slow
  // engine-creation await can't let an older query outrank a newer one.
  givenToken?: number,
): Promise<void> {
  if (!session) return;
  const token = givenToken ?? ++runToken;
  let active = session;
  // Range-mode cost cap: stop after byteBudget bytes fetched or timeMs elapsed
  // since this run began (steps are only the safety ceiling remotely). Not
  // applied in memory/disk mode, where there is no fetch cost.
  const rs = rangeSource;
  const startBytes = rs?.bytesFetched ?? 0;
  const startTime = Date.now();
  const shouldStop =
    rs && (byteBudget > 0 || timeMs > 0)
      ? () =>
          (byteBudget > 0 && rs.bytesFetched - startBytes >= byteBudget) ||
          (timeMs > 0 && Date.now() - startTime >= timeMs)
      : undefined;
  const engineOf = (s: typeof active) => (s instanceof WasmSession ? "wasm" : "js");
  const onProgress = (steps: number) => {
    if (token !== runToken) return; // superseded: stop talking to the UI
    post({
      type: "progress",
      steps: searchStepBase + steps,
      engine: engineOf(active),
      fetched: rangeSource?.bytesFetched,
      requests: rangeSource?.requests,
    });
  };
  const yieldCheck = () => {
    if (token !== runToken) throw new StopError();
    // Yield so incoming messages (stop / continue) are processed.
    return macroYield();
  };
  // With a compound filter the index has to be consulted per candidate, which
  // may fetch bytes, so results are collected and verified after the run
  // rather than streamed.
  const pending: Array<{ score: number; text: string }> = [];
  const emit = (r: { score: number; text: string }) => {
    if (token !== runToken) return; // superseded: stop talking to the UI
    emitted.add(r.text);
    if (resultFilters.length > 0 || nearOrder) {
      pending.push(r);
      return;
    }
    post({ type: "result", score: r.score, text: r.text });
  };
  const flushPending = async (): Promise<void> => {
    const filters = resultFilters;
    if (filters.length === 0 && !nearOrder) return;
    if (nearOrder) {
      const order = nearOrder;
      pending.sort(
        (a, b) => nearOrderKey(order, a.text) - nearOrderKey(order, b.text),
      );
    }
    if (filters.length === 0) {
      for (const r of pending) {
        if (token !== runToken) return;
        post({ type: "result", score: r.score, text: r.text });
      }
      return;
    }
    for (const r of pending) {
      if (token !== runToken) return;
      if (active instanceof SearchSession) ++active.predicateChecks;
      const verdict = await applyResultFilters(
        filters,
        r.text,
        ctx,
        isIndexedWord,
      );
      if (!verdict.keep) continue;
      if (active instanceof SearchSession) ++active.predicatePassed;
      post({
        type: "result",
        score: r.score,
        text: r.text,
        ...(verdict.notes.length === 0 ? {} : { note: verdict.notes.join("  ") }),
      });
    }
  };
  activeRunSession = active;
  try {
    let status;
    try {
      status = await active.run(maxSteps, maxResults, emit, onProgress, yieldCheck, shouldStop);
    } catch (e) {
      if (
        !(active instanceof WasmSession) ||
        e instanceof StopError ||
        token !== runToken ||
        !reader ||
        currentQuery === null
      ) {
        throw e;
      }
      // Kernel capacity overflow (or trap): replay this query on the JS
      // engine. Identical score-streams mean the replay regenerates exactly
      // the results already posted; suppress those.
      if (!(e instanceof WasmCapacityError)) wasmBroken = true;
      // Carry the overflowed kernel's step count forward so the progress
      // counter continues instead of resetting to zero on the replay.
      searchStepBase += active.steps;
      const js = new SearchSession(reader, currentQuery, ctx, undefined, {
        prefetchDepth: rangeSource ? PREFETCH_DEPTH : 0,
      });
      session = js;
      active = js;
      activeRunSession = js;
      // The replay regenerates every already-posted (suppressed) result;
      // widen its result budget so suppression doesn't eat the new page.
      status = await js.run(
        maxSteps,
        maxResults + emitted.size,
        (r) => {
          if (!emitted.has(r.text)) emit(r);
        },
        onProgress,
        yieldCheck,
        shouldStop,
      );
    }
    if (token !== runToken) return;
    await flushPending();
    if (token !== runToken) return;
    post({
      type: "done",
      status, // "limit" (step budget), "results" (page full), "exhausted"
      steps: searchStepBase + active.steps,
      // Only the JS engine keeps the detailed counters; the kernel reports
      // steps and nothing else, which the panel says rather than showing
      // zeros as though they were measurements.
      stats: active instanceof SearchSession ? active.stats() : null,
      engine: engineOf(active),
      fetched: rangeSource?.bytesFetched,
      requests: rangeSource?.requests,
    });
  } catch (e) {
    if (e instanceof StopError || token !== runToken) return;
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    // Only clear our own registration — a stale run finishing late must not
    // wipe the marker of the run that replaced it.
    if (activeRunSession === active) activeRunSession = null;
  }
}


// self.onmessage (not bare onmessage): survives IIFE bundling for the inlined
// offline worker, where an undeclared assignment would fail in strict mode.
self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  // Wake any parked runs: superseded ones re-check their token and unwind
  // promptly instead of lingering until some other run happens to yield.
  yieldChannel.port2.postMessage(0);
  try {
    switch (msg.type) {
      case "open":
        ++runToken;
        await openIndex(msg.url, msg.early);
        break;
      case "open-file":
        ++runToken;
        await openFile(msg.file);
        break;
      case "search": {
        if (!reader) throw new Error("no index loaded");
        const token = ++runToken;
        currentQuery = msg.query;
        // `{compound N:PATTERN}` is a corpus filter around an ordinary
        // pattern: strip it, search the pattern, verify the pieces after.
        // Compilation is synchronous, so anything it needs must be here
        // first.
        if (
          needsPhonetics(currentQuery) ||
          needsThesaurus(currentQuery) ||
          needsNeighbours(currentQuery) ||
          needsCategories(currentQuery) ||
          needsStress(currentQuery) ||
          needsWikiLists(currentQuery)
        ) {
          try {
            if (needsPhonetics(currentQuery)) {
              await ensureExtra(
                "phonetics",
                msg.phoneticsUrl ?? null,
                async (r) => {
                  ctx.phonetics = parsePhonetics(await r.text());
                },
              );
            }
            if (needsWikiLists(currentQuery)) {
              await ensureExtra(
                "lists",
                msg.listsUrl ?? null,
                async (r) => {
                  ctx.lists = parseWikiLists(await r.text());
                },
              );
              // Hand the catalogue to the page as well: it drives the
              // completions in the box, which otherwise only ever knows the
              // list names compiled into the bundle.
              if (ctx.lists) post({ type: "lists-ready", lists: ctx.lists });
            }
            if (needsStress(currentQuery)) {
              await ensureExtra(
                "stress",
                msg.stressUrl ?? null,
                async (r) => {
                  ctx.stress = parseStress(await r.text());
                },
              );
            }
            if (needsCategories(currentQuery)) {
              await ensureExtra(
                "categories",
                msg.categoriesUrl ?? null,
                async (r) => {
                  ctx.categories = parseCategories(await r.text());
                },
              );
            }
            if (needsNeighbours(currentQuery)) {
              await ensureExtra(
                "neighbours",
                msg.neighboursUrl ?? null,
                async (r) => {
                  ctx.neighbours = parseNeighbours(await r.arrayBuffer());
                },
              );
            }
            if (needsThesaurus(currentQuery)) {
              await ensureExtra(
                "thesaurus",
                msg.thesaurusUrl ?? null,
                async (r) => {
                  ctx.thesaurus = parseThesaurus(await r.text());
                },
              );
            }
          } catch {
            // Fall through: the parser reports what is missing.
          }
          if (token !== runToken) return;
        }
        // Ordering by closeness needs the same list the pattern was built
        // from — including its count, which a second regex here used to drop.
        nearOrder = null;
        const near = shapeOfQuery(currentQuery, 1).near;
        if (near && ctx.neighbours) {
          const list = nearestTo(ctx.neighbours, near.word, near.limit);
          if (list) nearOrder = new Map(list.map((w, i) => [w, i]));
        }
        resultFilters = [];
        try {
          const wrapped = parseFilterWrappers(currentQuery);
          resultFilters = wrapped.specs;
          currentQuery = wrapped.inner;
        } catch (e) {
          post({
            type: "error",
            message: e instanceof FilterError ? e.message : String(e),
          });
          return;
        }
        emitted = new Set();
        searchStepBase = 0; // fresh query: no discarded-engine steps yet
        session = null;
        const wasmEligible =
          !wasmBroken &&
          (memBytes !== null ||
            (diskSource !== null && currentSize <= WASM_INDEX_LIMIT));
        if (wasmEligible) {
          try {
            const engine = await getWasmEngine();
            if (token !== runToken) return; // superseded while instantiating
            session = new WasmSession(engine, currentQuery, ctx);
          } catch (e) {
            if (e instanceof ParseError) {
              post({ type: "parse-error", rest: e.rest, detail: e.detail });
              return;
            }
            // A superseded search may fail for staleness reasons (its index
            // was switched or removed mid-flight) — that says nothing about
            // the environment.
            if (token !== runToken) return;
            // Engine unavailable here (instantiation/memory/capacity):
            // quietly use the JS engine, and stop retrying environmental
            // failures every search.
            if (
              !(e instanceof WasmCapacityError) &&
              !(e instanceof WasmUnsupportedError)
            ) {
              wasmBroken = true;
            }
            session = null;
          }
        }
        if (!session) {
          try {
            session = new SearchSession(reader, currentQuery, ctx, undefined, {
              prefetchDepth: rangeSource ? PREFETCH_DEPTH : 0,
            });
          } catch (e) {
            if (e instanceof ParseError) {
              post({ type: "parse-error", rest: e.rest, detail: e.detail });
              return;
            }
            throw e;
          }
        }
        if (token !== runToken) return; // superseded during setup
        await runSession(msg.maxSteps, msg.maxResults, msg.byteBudget ?? 0, msg.timeMs ?? 0, token);
        break;
      }
      case "continue":
        if (!session) {
          // e.g. a continue racing an index switch: never leave the UI
          // waiting on a done that will not come.
          throw new Error("no search to continue");
        }
        // Duplicate continue for the session that's already running: that
        // run will answer. (A stale run of a REPLACED session doesn't match
        // and must not block — dropping here would hang the UI.)
        if (activeRunSession === session) break;
        await runSession(msg.maxSteps, msg.maxResults, msg.byteBudget ?? 0, msg.timeMs ?? 0);
        break;
      case "download-full": {
        ++runToken; // cancel any in-flight search run
        const gen = openGen;
        try {
          await downloadFull();
        } catch (e) {
          if (gen !== openGen) break; // superseded by a newer open: hush
          // The previously loaded index is still usable — tell the UI to
          // restore it rather than showing a dead "load failed" state.
          post({
            type: "download-error",
            message: e instanceof Error ? e.message : String(e),
          });
          // Restore the pre-download UI, refreshing the resume point: a
          // cancel or a mid-transfer network drop leaves a partial behind.
          if (lastReady) {
            const partial = currentUrl
              ? await checkPartial(currentUrl, currentSize, currentValidator)
              : null;
            post(
              typeof lastReady === "object" && lastReady !== null
                ? { ...(lastReady as object), partial: partial ?? undefined }
                : lastReady,
            );
          }
        }
        break;
      }
      case "cancel-download":
        downloadCtrl?.abort();
        break;
      case "remove-copy": {
        // Free the device copy (OPFS + any Cache Storage full copy), then
        // reopen the index in its default mode.
        if (!currentUrl) break;
        ++runToken;
        const url = currentUrl;
        diskSource?.close();
        diskSource = null;
        await opfsRemove(url);
        await openCacheNamed().then((c) => c?.delete(url)).catch(() => {});
        await openIndex(url);
        break;
      }
      case "stop":
        ++runToken;
        break;
      case "list-copies":
        post({ type: "copies", urls: await listOpfsCopies() });
        break;
      case "check": {
        // The same compileQuery a search runs, so "valid" means exactly what
        // it will mean when they press enter. Side data it would need is *not*
        // fetched: typing "{kind:b" must not pull a megabyte, so a
        // data-unavailable complaint is reported as "still fine".
        let error: { detail: string; at: number } | null = null;
        const text = msg.query.trim();
        if (text !== "") {
          try {
            // Peel what the engine never sees, in the same order the page
            // and the worker peel it, so a wrapper mistake is reported too.
            let inner = text;
            const at = parseExtract(inner);
            if (at) inner = at.inner;
            const ranked = parseRank(inner);
            if (ranked) inner = ranked.inner;
            inner = parseFilterWrappers(inner).inner;
            compileQuery(inner, ctx);
          } catch (e) {
            if (e instanceof ParseError && !e.dataMissing) {
              // `rest` is the tail the parser could not consume, so the
              // offset is however much it did consume.
              const at = Math.max(0, msg.query.length - e.rest.length);
              error = { detail: e.message, at };
            } else if (e instanceof FilterError || e instanceof ExtractError) {
              error = { detail: (e as Error).message, at: 0 };
            }
          }
        }
        post({ type: "checked", seq: msg.seq, error });
        break;
      }
      case "plan": {
        let lines: string[] = [];
        try {
          lines = formatPlan(planQuery(msg.query, ctx));
        } catch (e) {
          lines = [`cannot plan: ${e instanceof Error ? e.message : String(e)}`];
        }
        post({ type: "planned", lines });
        break;
      }
      case "explain": {
        // currentQuery is the engine-level pattern: the result filter and the
        // output wrappers have already been peeled off it, which is exactly
        // what the explanation should be about.
        const reasons =
          currentQuery === null ? [] : explainMatch(currentQuery, msg.text, ctx);
        post({ type: "explanation", text: msg.text, reasons });
        break;
      }
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
