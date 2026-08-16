// Turn the CMU pronouncing dictionary into the two groupings the query
// language actually needs, so nothing phonetic has to happen at query time:
//
//   R <word> <word> …   words that rhyme with each other
//   H <word> <word> …   words that sound identical (homophones)
//
// A rhyme is the tail of the pronunciation from the last stressed vowel, which
// is the convention English rhyme follows: TREE/AGREE rhyme, TREE/TREATY do
// not. Stress marks are dropped from the comparison so KEY and QUAY match.
//
// usage: node scripts/build-phonetics.mjs cmudict.dict [out.txt]

import fs from "node:fs";

const [dictPath, outPath = "web/public/phonetics.txt"] = process.argv.slice(2);
if (!dictPath) {
  console.error("usage: build-phonetics.mjs cmudict.dict [out.txt]");
  process.exit(2);
}

/** Corpus spelling rules: lowercase, apostrophes vanish, else a space. */
function normalize(word) {
  return word
    .toLowerCase()
    .replace(/\(\d+\)$/, "") // cmudict's alternate-pronunciation marker
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const rhymes = new Map(); // rhyme key -> Set of spellings
const homophones = new Map(); // full pronunciation -> Set of spellings

for (const line of fs.readFileSync(dictPath, "utf8").split("\n")) {
  if (!line || line.startsWith(";;;")) continue;
  const hash = line.indexOf("#");
  const body = hash === -1 ? line : line.slice(0, hash);
  const parts = body.trim().split(/\s+/);
  if (parts.length < 2) continue;
  const word = normalize(parts[0]);
  // Groups are space-delimited, so a spelling that normalises to several
  // tokens ("u.s." -> "u s") would silently split and merge unrelated groups.
  if (!word || word.includes(" ")) continue;
  const phones = parts.slice(1);

  // Rhyme runs from the last PRIMARY-stressed vowel: ANti carries its stress
  // on the first syllable, so it rhymes with AUNTIE, not with TREE — even
  // though its final IY takes secondary stress. Fall back to secondary, then
  // to any vowel, so unstressed monosyllables stay usable.
  let start = phones.findLastIndex((p) => /1$/.test(p));
  if (start === -1) start = phones.findLastIndex((p) => /2$/.test(p));
  if (start === -1) start = phones.findLastIndex((p) => /\d$/.test(p));
  if (start === -1) continue; // no vowel at all: nothing to rhyme with
  const bare = phones.map((p) => p.replace(/\d$/, ""));
  const rhymeKey = bare.slice(start).join(" ");
  const fullKey = bare.join(" ");

  if (!rhymes.has(rhymeKey)) rhymes.set(rhymeKey, new Set());
  rhymes.get(rhymeKey).add(word);
  if (!homophones.has(fullKey)) homophones.set(fullKey, new Set());
  homophones.get(fullKey).add(word);
}

const out = [];
let rhymeGroups = 0;
for (const words of rhymes.values()) {
  if (words.size < 2) continue; // a word that rhymes only with itself is noise
  out.push(`R ${[...words].join(" ")}`);
  ++rhymeGroups;
}
let homoGroups = 0;
for (const words of homophones.values()) {
  if (words.size < 2) continue;
  out.push(`H ${[...words].join(" ")}`);
  ++homoGroups;
}

fs.writeFileSync(outPath, `${out.join("\n")}\n`);
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(
  `wrote ${outPath}: ${rhymeGroups} rhyme groups, ${homoGroups} homophone groups, ${kb} KB`,
);
