// The storage manager's download arm (the page is web/storage.ts; the OPFS
// primitives are web/worker/opfs.ts). Everything else the manager does —
// listing device copies, sizing caches, deleting — runs on the page, because
// OPFS enumeration and the Cache API work on a window. Writing a download
// does not: it needs synchronous access handles, which are worker-only. So
// this worker does exactly one thing, on the same modules the search worker
// uses (downloads.ts / storage.ts), for any URL it is handed — a forward
// index or its reverse sidecar alike.

import {
  DownloadReporter,
  checkQuota,
  downloadToOpfs,
} from "./worker/downloads.js";
import { StopError } from "./worker/net.js";

interface DownloadMsg {
  type: "download";
  url: string;
}
interface CancelMsg {
  type: "cancel";
  url: string;
}
type InMsg = DownloadMsg | CancelMsg;

export type StorageOutMsg =
  | { type: "started"; url: string }
  | { type: "progress"; url: string; loaded: number; total: number }
  | { type: "done"; url: string; size: number }
  | { type: "error"; url: string; message: string };

const post = (m: StorageOutMsg) => (self as unknown as Worker).postMessage(m);

// Downloads queue rather than refuse: they would share one connection's
// bandwidth anyway, so running them in sequence costs nothing and lets a
// user click every row they want and walk away.
const queue: string[] = [];
let active: string | null = null;
let ctrl: AbortController | null = null;

/** Size and cache validator for a URL, from a one-byte range probe. */
async function probe(url: string): Promise<{ size: number; validator: string | null }> {
  const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
  try {
    r.body?.cancel();
  } catch {
    // locked body: harmless
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const range = r.headers.get("content-range");
  const m = range === null ? null : /\/(\d+)$/.exec(range);
  const size = m
    ? parseInt(m[1], 10)
    : parseInt(r.headers.get("content-length") ?? "", 10);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("the server did not report a size");
  }
  if (r.status !== 206) {
    throw new Error("the server does not support range requests");
  }
  return {
    size,
    validator: r.headers.get("etag") ?? r.headers.get("last-modified"),
  };
}

async function download(url: string): Promise<void> {
  ctrl = new AbortController();
  post({ type: "started", url });
  try {
    const { size, validator } = await probe(url);
    await checkQuota(size);
    void navigator.storage.persist?.().catch(() => {});
    const report: DownloadReporter = {
      progress: (loaded, total) => post({ type: "progress", url, loaded, total }),
      cachedHit: (s) => post({ type: "progress", url, loaded: s, total: s }),
    };
    const disk = await downloadToOpfs(url, size, validator, report, ctrl.signal);
    if (!disk) throw new Error("device storage (OPFS) is unavailable here");
    disk.close(); // the manager stores; the search worker opens
    post({ type: "done", url, size });
  } catch (e) {
    post({
      type: "error",
      url,
      message:
        e instanceof StopError
          ? "cancelled"
          : e instanceof Error
            ? e.message
            : String(e),
    });
  } finally {
    ctrl = null;
  }
}

async function pump(): Promise<void> {
  if (active !== null) return; // the running loop will pick the queue up
  while (queue.length > 0) {
    active = queue.shift()!;
    await download(active);
    active = null;
  }
}

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === "download") {
    if (msg.url !== active && !queue.includes(msg.url)) queue.push(msg.url);
    void pump();
  } else if (msg.type === "cancel") {
    if (msg.url === active) {
      ctrl?.abort();
    } else {
      const i = queue.indexOf(msg.url);
      if (i !== -1) {
        queue.splice(i, 1);
        post({ type: "error", url: msg.url, message: "cancelled" });
      }
    }
  }
};
