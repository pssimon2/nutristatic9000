// Every example link must search what it says it searches.
//
//   node scripts/check-links.mjs
//
// The pages are full of runnable examples written as `<a href="?q=…">{query}</a>`,
// and the href is hand-encoded. Four of them had doubled braces —
// `{syllables=3:A{7}}` linked to `{{syllables=3:A{{7}}}}`, which is not a
// query at all — and sixteen more pointed at `/?q=`, the *parent* deployment,
// rather than the page they sit on. Both are invisible in review: the label
// reads correctly, and only clicking finds out.
//
// Two rules:
//   * the href's query must equal the link's own text;
//   * the href must be relative, since the same page is served from `/` and
//     from `/9000/` and an absolute link silently leaves the fork.
//
// A label containing an ellipsis is prose, not a query, and is skipped.
//
// The label pattern allows markup inside the anchor, because the recipes page
// writes `<a …><tt>{kind:bird}</tt></a>`. Requiring bare text made this skip
// all 24 of that page's links while reporting the other 140 as OK — it was
// not passing them, it had never seen them, and every one was absolute.

import * as fs from "node:fs";
import * as path from "node:path";

// Every page that ships. indexes.html and lists.html were missing, and
// indexes.html was broken because of it: it offered `./en-wiki.index`, which
// from /9000/ resolves to /9000/en-wiki.index and 404s. The big indexes live
// once at the site root and are shared by both deployments.
const FILES = [
  "web/index.html",
  "web/public/usage.html",
  "web/public/recipes.html",
  "web/public/indexes.html",
  "web/public/lists.html",
  "web/storage.html",
];

const unescape = (t) =>
  t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");

const problems = [];
let checked = 0;

for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, "utf8");
  for (const m of html.matchAll(/<a href="([^"?]*)\?q=([^"]*)"[^>]*>(.*?)<\/a>/gs)) {
    const [, prefix, encoded, inner] = m;
    // The label may be marked up — `<tt>{kind:bird}</tt>` is the house style
    // on the recipes page — so strip tags before comparing. Requiring bare
    // text made this skip all 24 links in recipes.html while reporting the
    // other 142 as "OK", which is the failure mode a checker must not have:
    // it was not passing them, it had never seen them.
    const label = unescape(inner.replace(/<[^>]*>/g, ""))
      .split(/\s+/)
      .join(" ")
      .trim();
    if (label.includes("…")) continue; // prose, not a runnable query
    ++checked;

    if (prefix.startsWith("/")) {
      problems.push(
        `${file}: "${label}" links to ${prefix}?q=… — absolute, so it leaves ` +
          `the deployment it is served from; use "./?q=" or "?q="`,
      );
    }
    // Only the `q` parameter, not everything after it. A query's own `&` — the
    // intersection operator — is always written `%26` in these links, so a
    // bare `&` (`&amp;` in the source) starts another parameter:
    // `?q=<waterhegm>%26…&amp;index=demo.index` is one query and one index
    // choice. Reading to the end of the href made that link report as
    // searching "…&amp;index=demo.index" and fail.
    const qParam = unescape(encoded).split("&")[0];
    const target = decodeURIComponent(qParam).split(/\s+/).join(" ").trim();
    if (target !== label) {
      problems.push(`${file}: "${label}" actually searches "${target}"`);
    }
  }
}

// Navigation links have the same invariant and were not being checked at all:
// usage.html sent "back to search" to `/` (leaving the fork for the parent)
// and recipes.html sent it to `/9000/` (dragging the parent into the fork).
// Site-wide files that really do live at the root are exempt.
// Files that really do live once at the site root, shared by every
// deployment: the legal pages, the favicon, and the index data itself — which
// is far too large to duplicate per deployment and is linked as `/en-wiki.index`
// by the page's own index picker.
// Root-level shared files, plus the versioned index tree /idx/<edition>/…
// — the big indexes live once at the site root and are shared by both
// deployments, so linking them absolutely is correct.
const ROOT_FILES =
  /^\/(favicon\.ico|impressum\.html|datenschutz\.html|robots\.txt|(idx\/[a-z0-9-]+\/)?[a-z-]+\.(index|idxz))$/;
for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, "utf8");
  for (const m of html.matchAll(/<a href="(\/[^"?]*)"/g)) {
    const href = m[1];
    if (ROOT_FILES.test(href)) continue;
    problems.push(
      `${file}: navigation link to ${href} is absolute — it leaves the ` +
        `deployment the page is served from; use "./"`,
    );
  }
}

/** Files the build produces, so they are absent from the source tree. */
const GENERATED = new Set([
  "nutristatic-offline.html",
  // scripts/build-skill.mjs packages skills/nutri-url/SKILL.md into these.
  "nutri-url-skill.md",
  "nutri-url-skill.zip",
]);

// A relative link must point at something that ships. This is what would have
// caught indexes.html offering `./en-wiki.index`: relative is not the same as
// correct, and the absolute-link rule above says nothing about a path that
// resolves inside the deployment and finds nothing there.
for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const dir = path.dirname(file);
  const html = fs.readFileSync(file, "utf8");
  for (const m of html.matchAll(/(?:href|src)="(?!https?:|\/|#|\?|data:|mailto:)([^"#?]+)/g)) {
    const target = m[1];
    if (target === "" || target.endsWith("/")) continue; // the page itself
    // Written into web/dist by the build, not committed to web/public.
    if (GENERATED.has(path.basename(target))) continue;
    const onDisk = path.join(dir, target);
    // Pages live beside each other; assets may be in web/public either way.
    if (fs.existsSync(onDisk) || fs.existsSync(path.join("web/public", target))) {
      continue;
    }
    problems.push(
      `${file}: relative link to "${target}" — nothing ships at that path, ` +
        `so it 404s from the deployment it is served from`,
    );
  }
}

if (problems.length > 0) {
  console.error("links that do not do what they say:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\n${problems.length} problem${problems.length === 1 ? "" : "s"}, ` +
      `across ${checked} example queries and every navigation link.`,
  );
  process.exit(1);
}

console.error(
  `links OK: ${checked} example queries match their labels, ` +
    `and no page links out of its own deployment`,
);
