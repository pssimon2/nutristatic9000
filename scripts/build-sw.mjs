// Postbuild: inject the content-hashed shell asset list and a cache version
// into the built service worker (web/dist/sw.js). Runs after `vite build`,
// which copies web/public/sw.js (with placeholders) into web/dist.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dist = path.resolve(process.env.NUTRISTATIC_DIST || "web/dist");
const swPath = path.join(dist, "sw.js");
if (!fs.existsSync(swPath)) {
  console.error(`build-sw: ${swPath} not found (is web/public/sw.js present?)`);
  process.exit(1);
}

// The app shell. Paths are RELATIVE to sw.js so the same worker serves the
// app at the site root or under a path prefix (this fork ships at /9000/).
// The app shell: the entry HTML, a couple of small statics, and every
// content-hashed asset (the main bundle, the search worker, the WASM kernel).
const precache = ["index.html"];
for (const name of [
  "favicon.ico",
  "nutritea-small.png",
  // Installable-app assets: without these a launched PWA has no icon offline.
  "manifest.webmanifest",
  "apple-touch-icon.png",
  "icon-192.png",
]) {
  if (fs.existsSync(path.join(dist, name))) precache.push(name);
}
const assetsDir = path.join(dist, "assets");
if (fs.existsSync(assetsDir)) {
  for (const f of fs.readdirSync(assetsDir).sort()) {
    precache.push("assets/" + f);
  }
}

// Version = hash of the shell set, so each deploy gets a fresh cache name and
// the SW's activate handler evicts the previous one.
const version = crypto
  .createHash("sha256")
  .update(precache.join("\n"))
  .digest("hex")
  .slice(0, 12);

let sw = fs.readFileSync(swPath, "utf8");
if (!sw.includes("__VERSION__") || !sw.includes("[/*__PRECACHE__*/]")) {
  console.error("build-sw: placeholders not found in sw.js — already built?");
  process.exit(1);
}
sw = sw
  .replace("__VERSION__", version)
  .replace("[/*__PRECACHE__*/]", JSON.stringify(precache));
fs.writeFileSync(swPath, sw);
console.log(
  `build-sw: cached ${precache.length} shell files as nutristatic-shell-${version}`,
);
