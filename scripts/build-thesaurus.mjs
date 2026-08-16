// Reduce WordNet to the one thing the query language needs: for each word,
// the words it shares a sense with. Tab-separated so multi-word entries
// ("give up") survive, since the corpus has phrases too.
//
// This is a thesaurus, not a semantic model. It answers "what else means
// roughly this", which is the half of "seven letters, ?A??E??, clues something
// like reluctant" that a static file can answer honestly.
//
// usage: node scripts/build-thesaurus.mjs path/to/wordnet/dict [out.txt]

import fs from "node:fs";
import path from "node:path";

const [dictDir, outPath = "web/public/thesaurus.txt"] = process.argv.slice(2);
if (!dictDir) {
  console.error("usage: build-thesaurus.mjs wordnet-dict-dir [out.txt]");
  process.exit(2);
}

/** Corpus spelling rules, plus WordNet's own markers. */
function normalize(word) {
  return word
    .toLowerCase()
    .replace(/\(\w+\)$/, "") // WordNet marks adjective position: able(p)
    .replace(/_/g, " ")
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const groups = [];
for (const pos of ["noun", "verb", "adj", "adv"]) {
  const file = path.join(dictDir, `data.${pos}`);
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    // The licence block at the head of each file is indented; data lines are
    // not.
    if (!line || line.startsWith(" ")) continue;
    const gloss = line.indexOf(" | ");
    const fields = (gloss === -1 ? line : line.slice(0, gloss)).split(" ");
    const count = parseInt(fields[3], 16);
    if (!Number.isFinite(count) || count < 1) continue;
    const words = [];
    for (let i = 0; i < count; ++i) {
      const word = normalize(fields[4 + i * 2] ?? "");
      if (word) words.push(word);
    }
    const unique = [...new Set(words)];
    // A sense with one word tells us nothing about any other word.
    if (unique.length > 1) groups.push(unique);
  }
}

fs.writeFileSync(outPath, `${groups.map((g) => g.join("\t")).join("\n")}\n`);
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`wrote ${outPath}: ${groups.length} sense groups, ${kb} KB`);
