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

const FILES = ["web/index.html", "web/public/usage.html", "web/public/recipes.html"];

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
    const target = decodeURIComponent(encoded).split(/\s+/).join(" ").trim();
    if (target !== label) {
      problems.push(`${file}: "${label}" actually searches "${target}"`);
    }
  }
}

// Navigation links have the same invariant and were not being checked at all:
// usage.html sent "back to search" to `/` (leaving the fork for the parent)
// and recipes.html sent it to `/9000/` (dragging the parent into the fork).
// Site-wide files that really do live at the root are exempt.
const ROOT_FILES = /^\/(favicon\.ico|impressum\.html|datenschutz\.html|robots\.txt)$/;
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
