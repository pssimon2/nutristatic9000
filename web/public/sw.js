// Service worker: caches the Nutristatic app shell (HTML + hashed JS/WASM/CSS)
// so the site loads and searches run with NO network, once an index has been
// stored on the device via "download whole index" (OPFS). Index and sidecar
// files are never cached here — they are large and managed by the app's own
// OPFS / Cache Storage layers.
//
// The precache list and cache version are injected at build time by
// scripts/build-sw.mjs from the content-hashed asset filenames.
const CACHE = "nutristatic9000-shell-__VERSION__";
// Precache entries are relative to this script, so the same worker serves the
// app whether it is deployed at the site root or under a path (/9000/).
const PRECACHE = [/*__PRECACHE__*/];
const BASE = new URL("./", location.href).pathname;
const SHELL = BASE + "index.html";
// The pronunciation and meaning datasets are large, rarely change, and are
// wanted offline once fetched — so they live in their own cache, which
// survives deploys instead of being thrown away with each new shell.
const DATA_CACHE = "nutristatic9000-data";
const DATA_FILES = /\/(phonetics|thesaurus|categories|stress)\.txt$|\/neighbours\.bin$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop shell caches from previous deploys.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("nutristatic9000-shell-") && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only ever touch our own app shell.
  if (url.origin !== location.origin) return; // custom remote index URLs
  if (url.pathname.startsWith("/stats")) return; // private dashboard
  if (req.headers.has("range")) return; // range reads for the index stream
  if (url.pathname.endsWith(".index") || url.pathname.endsWith(".idxz")) return;

  // Side datasets: cache-first and kept across deploys. Re-fetching a
  // megabyte-and-a-half every time the app is rebuilt would be pure waste.
  if (DATA_FILES.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(DATA_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const net = await fetch(req);
        if (net && net.ok) {
          await cache.put(req, net.clone());
          // These URLs carry a version, so drop any earlier copy of the same
          // file rather than keeping every version ever fetched.
          for (const old of await cache.keys()) {
            const oldPath = new URL(old.url).pathname;
            if (oldPath === url.pathname && old.url !== req.url) {
              await cache.delete(old);
            }
          }
        }
        return net;
      })(),
    );
    return;
  }

  // Page navigations: network-first (so redeploys show up immediately), then
  // fall back to the cached page — or the app shell — when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const key = url.pathname === BASE ? SHELL : url.pathname;
        try {
          const net = await fetch(req);
          if (net && net.ok) cache.put(key, net.clone());
          return net;
        } catch {
          return (
            (await cache.match(key)) ||
            (await cache.match(SHELL)) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Hashed assets and other shell files: cache-first (they are immutable),
  // populating on a miss so anything not precached still becomes offline-able.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const net = await fetch(req);
        if (net && net.ok) cache.put(req, net.clone());
        return net;
      } catch {
        return hit || Response.error();
      }
    })(),
  );
});
