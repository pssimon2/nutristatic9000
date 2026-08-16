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

const [listPath, outPath = "web/public/neighbours.bin", vocabArg, kArg] =
  process.argv.slice(2);
if (!listPath) {
  console.error("usage: build-neighbours.mjs count_1w.txt [out.bin] [vocab] [K]");
  process.exit(2);
}
const VOCAB = Number(vocabArg ?? 20000);
const K = Number(kArg ?? 48);

// Frequency-ordered, letters only: puzzle answers are words, not tokens.
const words = [];
for (const line of fs.readFileSync(listPath, "utf8").split("\n")) {
  const word = line.split(/\s+/)[0]?.toLowerCase();
  if (word && /^[a-z]{3,20}$/.test(word)) words.push(word);
  if (words.length >= VOCAB) break;
}
console.log(`vocabulary: ${words.length} words`);

const extract = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
  dtype: "fp32",
});

// Embed in batches, unit-normalised so cosine is a plain dot product.
const DIM = 384;
const vectors = new Float32Array(words.length * DIM);
const BATCH = 256;
const started = Date.now();
for (let i = 0; i < words.length; i += BATCH) {
  const slice = words.slice(i, i + BATCH);
  const out = await extract(slice, { pooling: "mean", normalize: true });
  vectors.set(out.data.slice(0, slice.length * DIM), i * DIM);
  if (i % (BATCH * 20) === 0) {
    const done = i + slice.length;
    const rate = done / ((Date.now() - started) / 1000);
    process.stdout.write(
      `\r  embedded ${done}/${words.length} (${rate.toFixed(0)}/s)   `,
    );
  }
}
console.log(`\n  embedding done in ${((Date.now() - started) / 1000).toFixed(0)}s`);

// Top-K per word. Blocked so the inner loop stays in cache; the whole thing is
// one dense matrix multiply that never has to be materialised.
const nbr = new Uint16Array(words.length * K);
const BLOCK = 64;
const t1 = Date.now();
const scores = new Float32Array(words.length);
for (let a = 0; a < words.length; a += BLOCK) {
  const end = Math.min(a + BLOCK, words.length);
  for (let i = a; i < end; ++i) {
    const base = i * DIM;
    scores.fill(-2);
    for (let j = 0; j < words.length; ++j) {
      if (j === i) continue;
      let dot = 0;
      const jb = j * DIM;
      for (let d = 0; d < DIM; ++d) dot += vectors[base + d] * vectors[jb + d];
      scores[j] = dot;
    }
    // Partial selection: K passes over a 20k array beats sorting it.
    for (let slot = 0; slot < K; ++slot) {
      let best = -1;
      let bestScore = -2;
      for (let j = 0; j < words.length; ++j) {
        if (scores[j] > bestScore) {
          bestScore = scores[j];
          best = j;
        }
      }
      nbr[i * K + slot] = best < 0 ? i : best;
      if (best >= 0) scores[best] = -2;
    }
  }
  const done = end;
  const rate = done / ((Date.now() - t1) / 1000);
  process.stdout.write(
    `\r  neighbours ${done}/${words.length} (${rate.toFixed(1)}/s)   `,
  );
}
console.log(`\n  neighbours done in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

// NSEM1: u32 count, u16 K, u32 wordBytes, words (newline-joined), then
// count*K u16 indices into the word list.
const wordBytes = Buffer.from(words.join("\n"), "utf8");
const header = Buffer.alloc(15); // 5 magic + u32 + u16 + u32
header.write("NSEM1", 0, "ascii");
header.writeUInt32LE(words.length, 5);
header.writeUInt16LE(K, 9);
header.writeUInt32LE(wordBytes.length, 11);
fs.writeFileSync(outPath, Buffer.concat([header, wordBytes, Buffer.from(nbr.buffer)]));
const mb = (fs.statSync(outPath).size / 1048576).toFixed(1);
console.log(`wrote ${outPath}: ${words.length} words x ${K} neighbours, ${mb} MB`);
