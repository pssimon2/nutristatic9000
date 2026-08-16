// Precompute semantic neighbours for a vocabulary, so the browser needs no
// model and no inference: `{near:X}` becomes a lookup, exactly like the
// thesaurus.
//
// A thesaurus only knows words that share a dictionary sense, which is why
// RELUCTANT gives LOATH but not UNWILLING. An embedding puts those two at 0.75
// cosine. What the query language needs, though, is not vectors — it is "which
// words are near this one", and that answer is small: computing it here turns
// an 8 MB vector table into a ~2 MB neighbour table with no runtime maths.
//
// usage: node scripts/build-neighbours.mjs count_1w.txt [out.bin] [vocab] [K]

import fs from "node:fs";
import { pipeline } from "@huggingface/transformers";
import { loadAntonyms } from "./wordnet-antonyms.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : argv[at + 1];
};
// Precomputed word vectors (word2vec/GloVe text format) instead of a model.
const VEC_FILE = flag("vec");
// WordNet dictionary directory, to drop antonyms from the neighbour lists.
const ANTONYM_DIR = flag("antonyms");
const [listPath, outPath = "web/public/neighbours.bin", vocabArg, kArg] =
  argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--vec" && argv[argv.indexOf(a) - 1] !== "--antonyms");
if (!listPath) {
  console.error("usage: build-neighbours.mjs count_1w.txt [out.bin] [vocab] [K]");
  process.exit(2);
}
const VOCAB = Number(vocabArg ?? 60000);
const K = Number(kArg ?? 40);
// Neighbour indices are u16, so the vocabulary has to fit in one.
if (VOCAB > 65535) {
  console.error("vocabulary must be <= 65535 (indices are u16)");
  process.exit(2);
}

// Frequency-ordered, letters only: puzzle answers are words, not tokens.
const candidates = [];
for (const line of fs.readFileSync(listPath, "utf8").split("\n")) {
  const word = line.split(/\s+/)[0]?.toLowerCase();
  if (word && /^[a-z]{3,20}$/.test(word)) candidates.push(word);
}

let words;
let DIM;
let vectors;
const started = Date.now();

if (VEC_FILE) {
  // Take the vocabulary from the intersection, in frequency order: a
  // frequency list contains tokens no vector set knows, and a vector set
  // contains words too rare to be worth a slot.
  const have = new Map();
  for (const line of fs.readFileSync(VEC_FILE, "utf8").split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const word = line.slice(0, sp).toLowerCase();
    if (!have.has(word)) have.set(word, line.slice(sp + 1));
  }
  words = candidates.filter((w) => have.has(w)).slice(0, VOCAB);
  DIM = have.get(words[0]).trim().split(" ").length;
  vectors = new Float32Array(words.length * DIM);
  for (let i = 0; i < words.length; ++i) {
    const nums = have.get(words[i]).trim().split(" ");
    let norm = 0;
    for (let d = 0; d < DIM; ++d) {
      const v = Number(nums[d]);
      vectors[i * DIM + d] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIM; ++d) vectors[i * DIM + d] /= norm;
  }
  console.log(`vocabulary: ${words.length} words (${DIM}d, from ${VEC_FILE})`);
  console.log(`  vectors loaded in ${((Date.now() - started) / 1000).toFixed(0)}s`);
} else {
  words = candidates.slice(0, VOCAB);
  console.log(`vocabulary: ${words.length} words`);
  const extract = await pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2",
    { dtype: "fp32" },
  );
  DIM = 384;
  vectors = new Float32Array(words.length * DIM);
  const BATCH = 256;
  for (let i = 0; i < words.length; i += BATCH) {
    const slice = words.slice(i, i + BATCH);
    const out = await extract(slice, { pooling: "mean", normalize: true });
    vectors.set(out.data.slice(0, slice.length * DIM), i * DIM);
  }
  console.log(`  embedding done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

// Opposites sit very close in every embedding tested (38-63% of WordNet
// antonym pairs landed in the top 40), and a wrong answer that looks right is
// the worst kind. Drop the pairs WordNet can name.
const antonyms = ANTONYM_DIR ? loadAntonyms(ANTONYM_DIR) : new Map();
if (ANTONYM_DIR) {
  console.log(`  antonym pairs known: ${antonyms.size} words`);
}

// Top-K per word. Blocked so the inner loop stays in cache; the whole thing is
// one dense matrix multiply that never has to be materialised.
const nbr = new Uint16Array(words.length * K);
const BLOCK = 64;
const t1 = Date.now();
const topScore = new Float32Array(K);
const topIdx = new Int32Array(K);
for (let a = 0; a < words.length; a += BLOCK) {
  const end = Math.min(a + BLOCK, words.length);
  for (let i = a; i < end; ++i) {
    const base = i * DIM;
    // Keep the running top K in a small sorted array (worst first) rather
    // than scanning the whole score vector K times: almost every candidate
    // loses to the current worst and costs one comparison.
    topScore.fill(-2);
    topIdx.fill(0);
    let worst = -2;
    const banned = antonyms.get(words[i]);
    for (let j = 0; j < words.length; ++j) {
      if (j === i) continue;
      let dot = 0;
      const jb = j * DIM;
      for (let d = 0; d < DIM; ++d) dot += vectors[base + d] * vectors[jb + d];
      if (dot <= worst) continue;
      if (banned && banned.has(words[j])) continue;
      // Slide it into place, dropping the current worst off the front.
      let at = 0;
      while (at < K - 1 && topScore[at + 1] < dot) {
        topScore[at] = topScore[at + 1];
        topIdx[at] = topIdx[at + 1];
        ++at;
      }
      topScore[at] = dot;
      topIdx[at] = j;
      worst = topScore[0];
    }
    // Stored nearest-first, so a smaller {near N:…} takes the closest N.
    for (let slot = 0; slot < K; ++slot) {
      nbr[i * K + slot] = topIdx[K - 1 - slot];
    }
  }
  const done = end;
  const rate = done / ((Date.now() - t1) / 1000);
  process.stdout.write(
    `\r  neighbours ${done}/${words.length} (${rate.toFixed(1)}/s)   `,
  );
}
console.log(`\n  neighbours done in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

// NSEM2: 16-byte header (5 magic + u32 count + u16 K + u32 wordBytes + pad),
// the newline-joined words padded to an even length, then count*K u16 indices.
//
// Both paddings exist so the index array starts 2-byte aligned: a Uint16Array
// view cannot begin at an odd offset, and with a 15-byte header that depended
// on whether the word list happened to have an odd length.
const rawWords = Buffer.from(words.join("\n"), "utf8");
const wordBytes =
  rawWords.length % 2 === 0
    ? rawWords
    : Buffer.concat([rawWords, Buffer.from("\n")]);
const header = Buffer.alloc(16);
header.write("NSEM2", 0, "ascii");
header.writeUInt32LE(words.length, 5);
header.writeUInt16LE(K, 9);
header.writeUInt32LE(wordBytes.length, 11);
fs.writeFileSync(outPath, Buffer.concat([header, wordBytes, Buffer.from(nbr.buffer)]));
const mb = (fs.statSync(outPath).size / 1048576).toFixed(1);
console.log(`wrote ${outPath}: ${words.length} words x ${K} neighbours, ${mb} MB`);
