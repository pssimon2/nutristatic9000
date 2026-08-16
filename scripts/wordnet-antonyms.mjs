// WordNet's antonym pairs, for keeping opposites out of semantic neighbours.
//
// Distributional embeddings place antonyms very close together — opposites
// appear in near-identical contexts — and QUICK returning SLOW is worse than
// useless for a solver, because it looks like an answer. WordNet marks
// antonymy explicitly with its "!" lexical pointer, so the pairs it knows can
// simply be removed.
//
// The pointer is lexical, not semantic: its 4-hex field says which word of the
// source synset relates to which word of the target, so the pair is
// word-to-word rather than sense-to-sense.

import fs from "node:fs";
import path from "node:path";

const PARTS = ["noun", "verb", "adj", "adv"];

function synsetWords(body) {
  const count = parseInt(body[3], 16);
  if (!Number.isFinite(count)) return null;
  const words = [];
  for (let i = 0; i < count; ++i) {
    const raw = body[4 + i * 2];
    if (!raw) return null;
    words.push(raw.toLowerCase().replace(/\(\w+\)$/, "").replace(/_/g, " "));
  }
  return words;
}

/** Map of word -> Set of its antonyms, both directions. */
export function loadAntonyms(dictDir) {
  const lines = new Map();
  const synsets = new Map();
  for (const pos of PARTS) {
    const file = fs.readFileSync(path.join(dictDir, `data.${pos}`), "utf8");
    const parsed = [];
    for (const line of file.split("\n")) {
      if (!line || line.startsWith(" ")) continue;
      const body = line.split(" | ")[0].split(" ");
      const words = synsetWords(body);
      if (!words) continue;
      synsets.set(`${body[2]}:${body[0]}`, words);
      parsed.push(body);
    }
    lines.set(pos, parsed);
  }

  const antonyms = new Map();
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    if (!antonyms.has(a)) antonyms.set(a, new Set());
    antonyms.get(a).add(b);
  };
  for (const parsed of lines.values()) {
    for (const body of parsed) {
      const words = synsetWords(body);
      if (!words) continue;
      const pCountAt = 4 + words.length * 2;
      const pCount = parseInt(body[pCountAt], 10);
      if (!Number.isFinite(pCount)) continue;
      for (let p = 0; p < pCount; ++p) {
        const at = pCountAt + 1 + p * 4;
        if (body[at] !== "!") continue;
        const target = synsets.get(`${body[at + 2]}:${body[at + 1]}`);
        if (!target) continue;
        const st = body[at + 3] ?? "0000";
        const from = parseInt(st.slice(0, 2), 16);
        const to = parseInt(st.slice(2), 16);
        // 0000 marks a synset-level pointer: relate every pairing.
        const sources = from > 0 ? [words[from - 1]] : words;
        const targets = to > 0 ? [target[to - 1]] : target;
        for (const a of sources) {
          for (const b of targets) {
            add(a, b);
            add(b, a);
          }
        }
      }
    }
  }
  return antonyms;
}
