// The storage manager: everything this site keeps on the device, in one
// place — device copies of indexes, their reverse sidecars, the side
// datasets, and the cached search pieces — with sizes, downloads and
// deletion. The point is the offline story: an index copy plus its sidecar
// plus the datasets is a fully offline puzzle kit, and until now only the
// first of the three could be managed at all.

import { reverseSidecarName } from "../src/reverse.js";
import { BUNDLED_INDEXES, DATASETS, dataUrl } from "./catalog.js";
import {
  coveredBytes,
  indexUrlAlias,
  opfsName,
  opfsOkName,
  parseOpfsMarker,
  parseOpfsProg,
  progName,
} from "./worker/storage.js";
import type { StorageOutMsg } from "./storage-worker.js";

// The manager may be a visitor's first page, so it registers the service
// worker itself — "store all datasets" works by fetching *through* the SW,
// and without one the fetches would cache nothing.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // caching unavailable; the page still reports and deletes
  });
}

const CHUNK_CACHE = "nutrimatic-chunks-v2";
const DATA_CACHE = "nutristatic9000-data";

const $ = (id: string) => document.getElementById(id)!;
const fmt = (n: number): string =>
  n >= 1024 * 1024 * 1024
    ? `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
    : n >= 1024 * 1024
      ? `${Math.round(n / (1024 * 1024))} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`;

const abs = (path: string): string => new URL(path, location.href).href;

// ---- OPFS status, readable from the page (no sync handles needed) ----

interface CopyStatus {
  state: "none" | "partial" | "complete";
  bytes: number; // on-device bytes for this file
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

async function readSmall(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<string | null> {
  try {
    const h = await root.getFileHandle(name);
    return await (await h.getFile()).text();
  } catch {
    return null;
  }
}

async function copyStatus(url: string): Promise<CopyStatus> {
  const own = await copyStatusAt(url);
  if (own.state !== "none") return own;
  // A copy may live under the URL's alias spelling (the same file is served
  // at the site root and under /idx/…): report it for this row.
  const alias = indexUrlAlias(url);
  return alias ? copyStatusAt(alias) : own;
}

async function copyStatusAt(url: string): Promise<CopyStatus> {
  const root = await opfsRoot();
  if (!root) return { state: "none", bytes: 0 };
  let fileSize = 0;
  try {
    const h = await root.getFileHandle(opfsName(url));
    fileSize = (await h.getFile()).size;
  } catch {
    return { state: "none", bytes: 0 };
  }
  const marker = parseOpfsMarker(await readSmall(root, opfsOkName(url)));
  if (marker && marker.size === fileSize) {
    return { state: "complete", bytes: fileSize };
  }
  const prog = parseOpfsProg(await readSmall(root, progName(url)));
  if (prog && coveredBytes(prog.ranges) > 0) {
    return { state: "partial", bytes: coveredBytes(prog.ranges) };
  }
  return { state: "none", bytes: fileSize };
}

async function removeCopy(url: string): Promise<void> {
  // The copy may live under the URL's alias spelling; clear both, and only
  // report failure if neither spelling could be removed (the row would not
  // offer removal unless one of them exists).
  const alias = indexUrlAlias(url);
  let removed = false;
  try {
    await removeCopyAt(url);
    removed = true;
  } catch (e) {
    if (!alias) throw e;
  }
  if (alias) {
    try {
      await removeCopyAt(alias);
      removed = true;
    } catch (e) {
      if (!removed) throw e;
    }
  }
}

async function removeCopyAt(url: string): Promise<void> {
  const root = await opfsRoot();
  if (!root) return;
  // Fails while a search tab holds the file open — surfaced to the user.
  await root.removeEntry(opfsName(url));
  await root.removeEntry(opfsOkName(url)).catch(() => {});
  await root.removeEntry(progName(url)).catch(() => {});
  try {
    localStorage.removeItem(`nutristatic-disk:${url}`);
  } catch {
    // no localStorage
  }
}

/** Cached range pieces for one index (and its .idxz), by exact key prefix. */
async function chunkBytes(url: string): Promise<number> {
  try {
    const cache = await caches.open(CHUNK_CACHE);
    let total = 0;
    for (const req of await cache.keys()) {
      if (req.url.startsWith(url + "?") || req.url.startsWith(url + ".idxz?")) {
        const r = await cache.match(req);
        if (r) total += (await r.blob()).size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function purgeChunks(url: string): Promise<void> {
  try {
    const cache = await caches.open(CHUNK_CACHE);
    for (const req of await cache.keys()) {
      if (req.url.startsWith(url + "?") || req.url.startsWith(url + ".idxz?")) {
        await cache.delete(req);
      }
    }
  } catch {
    // best-effort
  }
}

// ---- the download worker ----

const worker = new Worker(new URL("./storage-worker.ts", import.meta.url), {
  type: "module",
});
// Per-URL download state: clicked rows queue behind the running transfer.
const downloadState = new Map<string, "queued" | "active">();
const progressEls = new Map<string, HTMLProgressElement>();

worker.onmessage = (ev: MessageEvent<StorageOutMsg>) => {
  const msg = ev.data;
  if (msg.type === "progress") {
    const bar = progressEls.get(msg.url);
    if (bar) {
      bar.hidden = false;
      bar.max = msg.total;
      bar.value = msg.loaded;
    }
    return;
  }
  if (msg.type === "started") {
    downloadState.set(msg.url, "active");
    void render();
    return;
  }
  downloadState.delete(msg.url);
  if (msg.type === "error" && msg.message !== "cancelled") {
    $("note").textContent = `${msg.url.split("/").pop()}: ${msg.message}`;
  }
  void render();
};

function startDownload(url: string): void {
  downloadState.set(url, "queued");
  $("note").textContent = "";
  worker.postMessage({ type: "download", url });
  void render();
}

// ---- rendering ----

function button(label: string, act: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", act);
  return b;
}

// Renders overlap freely (a click and a worker message arrive together), and
// an interleaved pair used to append rows into the same table — two bars for
// one download. Each run builds off-DOM and only the newest may swap in.
let renderGen = 0;

async function render(): Promise<void> {
  const gen = ++renderGen;
  progressEls.clear();
  // Totals first: the browser's own accounting of this origin.
  try {
    const est = await navigator.storage.estimate();
    if (gen !== renderGen) return;
    $("total").textContent =
      est.usage != null
        ? `This site keeps ${fmt(est.usage)} on this device` +
          (est.quota != null ? ` (browser allows up to ${fmt(est.quota)})` : "") +
          "."
        : "";
  } catch {
    $("total").textContent = "";
  }

  const tbody = document.createElement("tbody");
  for (const [path, label] of BUNDLED_INDEXES) {
    const url = abs(path);
    const rev = reverseSidecarName(url);
    const [idx, revStat, chunks] = await Promise.all([
      copyStatus(url),
      copyStatus(rev),
      chunkBytes(url),
    ]);
    const tr = document.createElement("tr");

    const name = document.createElement("td");
    name.textContent = label;
    tr.append(name);

    const cell = (status: CopyStatus, target: string, what: string): HTMLTableCellElement => {
      const td = document.createElement("td");
      const dl = downloadState.get(target);
      if (dl === "active") {
        const bar = document.createElement("progress");
        progressEls.set(target, bar);
        td.append(
          bar,
          button("cancel", () => worker.postMessage({ type: "cancel", url: target })),
        );
      } else if (dl === "queued") {
        td.append(
          "queued ",
          button("cancel", () => worker.postMessage({ type: "cancel", url: target })),
        );
      } else if (status.state === "complete") {
        td.append(
          `${fmt(status.bytes)} `,
          button("delete", async () => {
            try {
              await removeCopy(target);
              await purgeChunks(target);
            } catch {
              $("note").textContent =
                `${what} is in use — close or switch the search tab using it, then retry`;
            }
            void render();
          }),
        );
      } else {
        td.append(
          button(status.state === "partial" ? "resume" : "download", () =>
            startDownload(target),
          ),
        );
        if (status.state === "partial") {
          td.append(
            ` (${fmt(status.bytes)} so far) `,
            button("discard", async () => {
              try {
                await removeCopy(target);
              } catch {
                $("note").textContent =
                  `${what} is in use — close or switch the search tab using it, then retry`;
              }
              void render();
            }),
          );
        }
      }
      return td;
    };

    tr.append(cell(idx, url, "the index"));
    // demo.index ships with the app and has no reverse sidecar to fetch.
    const revTd = path.startsWith("/")
      ? cell(revStat, rev, "the reverse sidecar")
      : document.createElement("td");
    tr.append(revTd);

    const chunksTd = document.createElement("td");
    if (chunks > 0 && idx.state !== "complete") {
      chunksTd.append(
        `${fmt(chunks)} `,
        button("clear", async () => {
          await purgeChunks(url);
          void render();
        }),
      );
    } else {
      chunksTd.textContent = chunks > 0 ? fmt(chunks) : "–";
    }
    tr.append(chunksTd);
    tbody.append(tr);
  }
  if (gen !== renderGen) return;
  $("indexes").replaceWith(tbody);
  tbody.id = "indexes";

  // Side datasets, through the service worker's cache.
  const dl = document.createElement("ul");
  let missing = 0;
  for (const [file, what] of DATASETS) {
    const url = dataUrl(file);
    if (!url) continue;
    const li = document.createElement("li");
    let size = 0;
    try {
      const hit = await (await caches.open(DATA_CACHE)).match(url);
      if (hit) size = (await hit.blob()).size;
    } catch {
      // cache API unavailable
    }
    if (size === 0) ++missing;
    li.append(
      `${file} — ${what}: `,
      size > 0 ? `${fmt(size)} ✓` : "not stored",
    );
    dl.append(li);
  }
  if (gen !== renderGen) return;
  $("datasets").replaceWith(dl);
  dl.id = "datasets";
  const allBtn = $("dl-datasets") as HTMLButtonElement;
  allBtn.textContent = missing > 0 ? `Store all ${DATASETS.length} datasets` : "All stored ✓";
  allBtn.disabled = missing === 0;
}

$("dl-datasets").addEventListener("click", async () => {
  ($("dl-datasets") as HTMLButtonElement).disabled = true;
  // A plain fetch is enough: the service worker caches these on the way past.
  for (const [file] of DATASETS) {
    const url = dataUrl(file);
    if (url) await fetch(url).catch(() => {});
  }
  void render();
});

$("rm-datasets").addEventListener("click", async () => {
  await caches.delete(DATA_CACHE).catch(() => {});
  void render();
});

$("rm-all").addEventListener("click", async () => {
  if (!confirm("Remove every device copy, sidecar, cached piece and dataset this site has stored?")) {
    return;
  }
  let locked = 0;
  const root = await opfsRoot();
  if (root) {
    const names: string[] = [];
    try {
      for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
        if (name.startsWith("idx-")) names.push(name);
      }
    } catch {
      // OPFS unavailable
    }
    for (const name of names) {
      try {
        await root.removeEntry(name);
      } catch {
        ++locked; // open in a search tab
      }
    }
  }
  await caches.delete(CHUNK_CACHE).catch(() => {});
  await caches.delete(DATA_CACHE).catch(() => {});
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("nutristatic-disk:")) localStorage.removeItem(key);
    }
  } catch {
    // no localStorage
  }
  $("note").textContent =
    locked > 0
      ? `${locked} file(s) are open in a search tab — close or switch it, then retry`
      : "";
  void render();
});

void render();
