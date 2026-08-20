// Generate a single self-contained offline build (nutristatic-offline.html)
// from the SAME sources as the served site — reuses web/main.ts, web/worker.ts
// and the whole src/ engine, with OFFLINE=true flipping on the file-picker
// path. Re-run after any change; nothing here is hand-maintained app logic.
//
//   node scripts/build-offline.mjs   ->  web/dist-offline/nutristatic-offline.html
//
// The result works by double-clicking (file://): no server, no network. The
// user picks a local .index file; File.slice() serves range reads.

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const p = (...s) => path.join(ROOT, ...s);

// Resolve `*.wasm?url` imports to an inline data: URI so the worker bundle is
// self-contained and fetch(kernelUrl) works over file://.
const wasmDataUri = {
  name: "wasm-data-uri",
  setup(build) {
    build.onResolve({ filter: /\.wasm\?url$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?url$/, "")),
      namespace: "wasm-url",
    }));
    build.onLoad({ filter: /.*/, namespace: "wasm-url" }, (args) => {
      const b64 = fs.readFileSync(args.path).toString("base64");
      return {
        contents: `export default "data:application/wasm;base64,${b64}"`,
        loader: "js",
      };
    });
  },
};

const common = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  define: { OFFLINE: "true" },
  minify: true,
  write: false,
};

// Worker: classic (iife) so it runs from a Blob URL over file://.
const workerBuild = await esbuild.build({
  ...common,
  entryPoints: [p("web/worker.ts")],
  format: "iife",
  plugins: [wasmDataUri],
});
const workerCode = workerBuild.outputFiles[0].text;

// Main: ES module (inline <script type="module"> executes over file://; only
// EXTERNAL module fetches are blocked). No external imports remain after
// bundling, and import.meta is valid in a module so the dead online branch
// can't trip the output format.
const mainBuild = await esbuild.build({
  ...common,
  entryPoints: [p("web/main.ts")],
  format: "esm",
});
const mainCode = mainBuild.outputFiles[0].text;

// `</script>` inside inline script text would close the tag early — escape it.
const safe = (s) => s.replace(/<\/script/gi, "<\\/script");

function dataUri(file, mime) {
  return `data:${mime};base64,${fs.readFileSync(p(file)).toString("base64")}`;
}

let html = fs.readFileSync(p("web/index.html"), "utf8");
// Drop the network early-fetch probe (offline has no URL to fetch).
html = html.replace(/\n?\s*<script>[\s\S]*?__earlyIndex[\s\S]*?<\/script>/, "");
// Inline the decorative image and favicon so the file is fully portable.
html = html
  .replace("./nutritea-small.png", dataUri("web/public/nutritea-small.png", "image/png"))
  .replace('href="./favicon.ico"', `href="${dataUri("web/public/favicon.ico", "image/x-icon")}"`);
// None of the sibling pages have a local target offline; point every one of
// them at the live site so they work whenever the user is online. Listed
// rather than pattern-matched so a new page shows up here as a decision:
// leaving one out ships a link that 404s from file://.
for (const page of [
  "usage",
  "indexes",
  "recipes",
  "storage",
  "lists",
  "impressum",
  "datenschutz",
]) {
  html = html.replace(
    new RegExp(`"\\./${page}\\.html`, "g"),
    `"https://nutristatic.org/9000/${page}.html`,
  );
}
// Drop the "download the offline version" link — this IS that file.
html = html.replace(/<li id="offlinelink">[\s\S]*?<\/li>/, "");
// Drop the installable-app links: a single file:// page has no manifest or
// icon files to resolve, and a PWA install makes no sense for it.
html = html.replace(/\n?\s*<link rel="manifest"[^>]*>/, "");
html = html.replace(/\n?\s*<link rel="apple-touch-icon"[^>]*>/, "");
// Swap the module <script src> for the inlined worker + main bundles.
// The replacement is a *function* on purpose. Passing bundled JavaScript as a
// replacement *string* hands it to `String.replace`'s `$` expansion, and
// minified JavaScript contains `$&` for reasons no one chose: esbuild is free
// to name a variable `$`, and when it named one that held 97 the comparison
// `e >= $ && e <= de` came out as `e>=$&&e<=de`. Each of those four `$&`s
// expanded to the matched <script> tag, so the bundle grew stray tags in the
// middle of an expression and the page parsed as neither HTML nor JS.
//
// Nothing about that is stable: which identifier gets named `$` shifts with
// any edit to the engine, so the build breaks for reasons unrelated to the
// change that triggers it, and only the offline test notices. A function
// replacer is not scanned for `$` at all.
html = html.replace(
  /<script type="module" src="\.\/main\.ts"><\/script>/,
  () =>
    `<script>globalThis.__WORKER_CODE__=${safe(JSON.stringify(workerCode))}</script>\n` +
    `<script type="module">${safe(mainCode)}</script>`,
);

const outDir = p("web/dist-offline");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "nutristatic-offline.html");
fs.writeFileSync(outFile, html);
const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.error(`wrote ${path.relative(ROOT, outFile)} (${kb} KB)`);

// Also drop it into the served build if present, so the site's "Offline
// version" link resolves after a plain `npm run build` (postbuild runs this).
const dist = p("web/dist");
if (fs.existsSync(dist)) {
  fs.writeFileSync(path.join(dist, "nutristatic-offline.html"), html);
  console.error("  also placed in web/dist/");
}
