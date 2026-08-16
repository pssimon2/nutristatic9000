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
  for (const m of html.matchAll(/<a href="([^"?]*)\?q=([^"]*)"[^>]*>([^<]+)<\/a>/g)) {
    const [, prefix, encoded, text] = m;
    const label = unescape(text).split(/\s+/).join(" ").trim();
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

if (problems.length > 0) {
  console.error("example links that do not do what they say:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} of ${checked} example links are wrong.`);
  process.exit(1);
}

console.error(`links OK: ${checked} example queries match their labels`);
