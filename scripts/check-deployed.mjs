// Is everything the picker offers actually there?
//
//   npx tsx scripts/check-deployed.mjs                       # the live site
//   BASE=http://localhost:8080/9000 npx tsx scripts/check-deployed.mjs
//
// The index files are large, live outside the repo, and are uploaded by hand, so
// no test in the repo can say whether they are in place. That gap had already
// cost something: `simple-wiki.index` was offered by the picker with no `.head`
// beside it, which is the failure the README warns about — the site still works
// and is much slower, `{palindrome:A{5}}` going from half a second to twenty and
// finding nothing, with nothing on the page to say why.
//
// So this asks the deployment three questions per index, by range request rather
// than by download: is the index there, is its compressed sidecar there, and is
// its head there. It also checks the app's own data files — the side datasets and
// the demo index, the ones written by hand rather than by the bundler — and
// checks their *size*, not just their presence: a deploy that shipped an old
// `lists.txt` looks fine and answers `{list:…}` from a stale catalogue. The
// bundled assets are content-hashed, so a stale one 404s and breaks the page
// loudly; these are the files that go wrong quietly.
//
// Not in CI, because CI has no deployment to look at; run it after uploading,
// which is exactly when a gap is still cheap to fix.

import * as fs from "node:fs";

const BASE = process.env.BASE ?? "https://nutristatic.org/9000";
/** Where the index files themselves live: the site root, shared between pages. */
const ROOT = new URL("..", `${BASE}/`).href.replace(/\/$/, "");

/** The indexes the picker offers, read from the page's own list. */
function offered() {
  const main = fs.readFileSync("web/main.ts", "utf8");
  const block = /BUNDLED_INDEXES[^[]*\[([\s\S]*?)\n\]/.exec(main);
  if (!block) throw new Error("could not find BUNDLED_INDEXES in web/main.ts");
  return [...block[1].matchAll(/"([^"]*\.index)"/g)].map((m) => m[1]);
}

/** Does this URL exist? A one-byte range, so a gigabyte index costs nothing. */
async function present(url) {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
    // 206 for a served range, 200 for a server that ignored it, 416 for an
    // empty file — all mean the file is there.
    return r.status === 206 || r.status === 200 || r.status === 416;
  } catch {
    return false;
  }
}

const problems = [];

// The app's own files, which ride along in the build output. Present is not
// enough: a deploy that shipped an old `lists.txt` would look fine and answer
// `{list:…}` from a stale catalogue, so the served size has to match the built
// one. A size is a weak hash and a strong enough one for "did this get
// uploaded" — the failure being guarded against is a forgotten file, not a
// corrupted byte.
const BUILT = "web/dist";
if (fs.existsSync(BUILT)) {
  const assets = fs
    .readdirSync(BUILT)
    .filter((f) => /\.(txt|bin|wasm)$/.test(f) || f === "demo.index");
  for (const file of assets.sort()) {
    const local = fs.statSync(`${BUILT}/${file}`).size;
    let served = -1;
    try {
      // `identity`, or the length is meaningless: asked with gzip accepted,
      // Caddy answers a HEAD with `content-length: 20` — the gzip of the body
      // it did not send. That reported all five text datasets as stale uploads
      // when every one of them was fine.
      const r = await fetch(`${BASE}/${file}`, {
        method: "HEAD",
        headers: { "Accept-Encoding": "identity" },
      });
      if (r.ok) served = Number(r.headers.get("content-length") ?? -1);
    } catch {
      // left as -1
    }
    const ok = served === local;
    console.error(
      `  ${file.padEnd(22)} ${
        ok
          ? "ok"
          : served === -1
            ? "NOT SERVED"
            : `STALE: serving ${served} bytes, built ${local}`
      }`,
    );
    if (!ok) {
      problems.push(
        served === -1
          ? `${file} is in the build and not served`
          : `${file} is served at ${served} bytes but the build has ${local} — a stale upload`,
      );
    }
  }
} else {
  console.error(`  (no ${BUILT} — run npm run build to check the app's files too)`);
}

const indexes = offered();
if (indexes.length === 0) throw new Error("no indexes found to check");

for (const path of indexes) {
  // `demo.index` ships with the app; everything else is a root-absolute URL.
  const isBundled = !path.startsWith("/");
  const indexUrl = isBundled ? `${BASE}/${path}` : `${ROOT}${path}`;
  const name = path.replace(/^\//, "").replace(/\.index$/, "");
  const checks = [
    [`${name}.index`, indexUrl],
    // A bundled index is small and fetched whole, so it needs no sidecars.
    ...(isBundled
      ? []
      : [
          [`${name}.index.idxz`, `${indexUrl}.idxz`],
          [`${name}.head`, `${BASE}/${name}.head`],
        ]),
  ];
  const missing = [];
  for (const [label, url] of checks) {
    if (!(await present(url))) missing.push(label);
  }
  console.error(
    `  ${name.padEnd(14)} ${missing.length === 0 ? "ok" : `MISSING ${missing.join(", ")}`}`,
  );
  for (const m of missing) problems.push(`${m} is offered by the picker but not served`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nA missing .head is the quiet one: the site still answers and is much ` +
      `slower. Build it with\n  npm run build-head -- <index> --out <name>.head\n` +
      `and check the pair with check-head.mjs before uploading.`,
  );
  process.exit(1);
}
console.error(
  `\ndeployment OK: ${indexes.length} indexes offered, each served with the ` +
    `sidecars it needs`,
);
