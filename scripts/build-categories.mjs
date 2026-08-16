// WordNet's "kind of" graph, for `{kind:bird}` — every name below a word in
// the hyponym hierarchy. BIRD reaches 1748 of them, so "a seven-letter bird"
// stops being a trivia question.
//
// The graph ships rather than the answers: precomputing every category's
// closure would repeat most of the dictionary once per level, while the graph
// is 75,916 edges and the closure is a breadth-first walk over a few thousand
// nodes at query time.
//
// Multi-word names ("bald eagle") are kept: the corpus indexes phrases too.
//
// usage: node scripts/build-categories.mjs <wordnet-dict-dir> [out.txt]

import fs from "node:fs";
import path from "node:path";

const [dictDir, outPath = "web/public/categories.txt"] = process.argv.slice(2);
if (!dictDir) {
  console.error("usage: build-categories.mjs wordnet-dict-dir [out.txt]");
  process.exit(2);
}

function normalize(word) {
  return word
    .toLowerCase()
    .replace(/\(\w+\)$/, "")
    .replace(/_/g, " ")
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Nouns carry the kind-of hierarchy; verbs have troponyms under the same "~".
const order = [];
const words = new Map(); // offset -> [words]
const kids = new Map(); // offset -> [offsets]
for (const pos of ["noun", "verb"]) {
  for (const line of fs.readFileSync(path.join(dictDir, `data.${pos}`), "utf8").split("\n")) {
    if (!line || line.startsWith(" ")) continue;
    const body = line.split(" | ")[0].split(" ");
    const count = parseInt(body[3], 16);
    if (!Number.isFinite(count)) continue;
    const key = `${pos[0]}:${body[0]}`;
    const names = [];
    for (let i = 0; i < count; ++i) {
      const w = normalize(body[4 + i * 2] ?? "");
      if (w) names.push(w);
    }
    if (names.length === 0) continue;
    words.set(key, [...new Set(names)]);
    order.push(key);
    const pAt = 4 + count * 2;
    const pCount = parseInt(body[pAt], 10);
    if (!Number.isFinite(pCount)) continue;
    const children = [];
    for (let p = 0; p < pCount; ++p) {
      const at = pAt + 1 + p * 4;
      if (body[at] !== "~") continue; // hyponym / troponym
      children.push(`${body[at + 2]}:${body[at + 1]}`);
    }
    if (children.length) kids.set(key, children);
  }
}

// Renumber to line indices so the shipped edges are small integers.
const index = new Map(order.map((k, i) => [k, i]));
const lines = order.map((key) => {
  const children = (kids.get(key) ?? [])
    .map((c) => index.get(c))
    .filter((i) => i !== undefined);
  return `${words.get(key).join("|")}\t${children.join(",")}`;
});

fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
const edges = [...kids.values()].reduce((n, c) => n + c.length, 0);
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(
  `wrote ${outPath}: ${lines.length} senses, ${edges} kind-of edges, ${kb} KB`,
);
