// Harvest `{list:…}` categories from a Wikipedia dump.
//
//   node scripts/build-wiki-lists.mjs <dump.xml.bz2> [--out web/public/lists.txt]
//                                     [--index web/public/demo.index] [--top 1000]
//   node scripts/build-wiki-lists.mjs <dump.xml.bz2> --sample   # inspect, write nothing
//
// English Wikipedia has ~148,000 "List of …" articles, so finding lists is not
// the problem — almost all of them are useless for puzzles ("List of townships
// in Pennsylvania", "List of Jimmy Neutron episodes"). The work is choosing.
//
// Three signals decide, and they disagree usefully:
//   * the title, which is what rules out place-scoped, year-scoped and
//     episode lists wholesale;
//   * the entries themselves — short, few words, no stray punctuation;
//   * how much of the list the corpus actually knows, measured against a real
//     index. A category whose members never appear in text cannot be an
//     answer to anything, and this is the signal only this project has.
//
// Corpus coverage alone is not enough: place names score extremely well
// because they appear in text constantly, so "List of cities in Iowa" beats
// "List of Roman gods".
//
// The signal that settles it is *incoming links*: how many of the encyclopedia's
// articles point at this list. It is Wikipedia's own editors voting on what is
// worth linking to, it costs nothing to collect (we are already reading every
// page), and it is a measurement rather than a taste — which the title rules,
// however tuned, are not. "List of colors" is linked from thousands of
// articles; "List of adverse effects of trazodone" is linked from one.

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";

const args = process.argv.slice(2);
const DUMP = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const SAMPLE = args.includes("--sample");
const OUT = opt("out", "web/public/lists.txt");
const INDEX = opt("index", "web/public/demo.index");
const TOP = Number(opt("top", "1000"));
// A floor as well as a ranking: taking the top N by score alone still admits
// "twin towns and sister cities in Switzerland" once the good lists run out.
const MIN_SCORE = Number(opt("min-score", "7"));
// Harvesting the dump takes ~9 minutes; scoring takes seconds. Cache the raw
// pass so the thresholds can be tuned without re-reading 24 GB.
const CACHE = opt("cache", null);

if (!DUMP) {
  console.error("usage: build-wiki-lists.mjs <dump.xml.bz2> [--out f] [--top n]");
  process.exit(2);
}

// ---- entry shaping ----

const MAX_ENTRY_CHARS = 25;
const MAX_ENTRY_WORDS = 3;

function normalize(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Entries from the three shapes a Wikipedia list actually uses: bullets,
 * numbered items, and table rows.
 *
 * Bullets alone miss a lot — many of the best-kept lists (elements, monarchs,
 * anything with dates or counts beside the name) are tables, and skipping them
 * does not merely lose those lists, it drags in worse ones to fill the quota.
 * In a table the subject is the first link of the row; later columns are its
 * attributes.
 */
function entryLink(line) {
  const t = line.trim();
  const bullet = /^[*#]+\s*\[\[([^\]]+)\]\]/.exec(t);
  if (bullet) return bullet[1];
  // Table cell, but not the control lines {| |- |+ |} or a header row.
  if (t.startsWith("|") && !/^\|[-+}]/.test(t) && !t.startsWith("|}")) {
    const cell = /\[\[([^\]]+)\]\]/.exec(t);
    if (cell) return cell[1];
  }
  return null;
}

function entriesFrom(lines) {
  const out = new Set();
  for (const line of lines) {
    const raw = entryLink(line);
    if (!raw) continue;
    const display = raw.includes("|") ? raw.slice(raw.indexOf("|") + 1) : raw;
    // "Ada (programming language)" is ADA; the qualifier is Wikipedia's, not
    // part of the name.
    const e = normalize(display.replace(/\s*\([^)]*\)\s*$/, ""));
    if (!e || e.length > MAX_ENTRY_CHARS) continue;
    if (e.split(" ").length > MAX_ENTRY_WORDS) continue;
    out.add(e);
  }
  return [...out];
}

// ---- title judgement ----

/** Titles that are about a place, a year, a broadcast or a bureaucracy. */
const TITLE_REJECT = [
  /\b(episode|season|character)s?\b/i,
  /\bschools?\b/i,
  /\b(cities|towns|villages|municipalities|communes|counties|districts|townships|parishes|suburbs|neighborhoods|neighbourhoods)\b/i,
  /\b(postal codes|streets|roads|highways|railway stations|metro stations|airports|bridges|dams|lighthouses)\b/i,
  /\b(accidents|incidents|attacks|earthquakes|disasters|shootings|massacres|battles|wars)\b/i,
  /\bdiplomatic missions\b/i,
  /\b(members|ambassadors|diplomats|governors|mayors|senators|representatives|ministers|bishops|justices)\b/i,
  /\bpeople\b/i,
  /\b(1[6-9]|20)\d\d\b/,
  /\bby\b/i,
  /\bin\s+(the\s+)?[A-Z]/,
  /\b(companies|banks|universities|colleges|hospitals|museums|churches|temples|stadiums)\b/i,
  /\b(populated places|census|constituencies|electoral)\b/i,
  /\b(singles|albums|songs|discograph|filmograph|bibliograph)/i,
  /\bnumber-one\b/i,
  /\bwith\b/i,
  /\betymolog/i,
  /\b(awards?|winners|nominees|ceremonies|medalists)\b/i,
  /\bvideo games\b/i,
  /\b(governing bodies|applications|units|regiments|battalions)\b/i,
  /\blotter/i,
  /\bteammates\b/i,
  /\b(champions?|championships?|laureates|events|records|statistics)\b/i,
  /\b(best-selling|number one|top-selling|highest)\b/i,
  /\b(individual|fictional|notable|famous|minor|extant)\b/i,
  /\b(sightings|rankings|refuges|tombs|manufacturers|constructors)\b/i,
  /\b(multigraphs|typefaces|file formats|auto parts)\b/i,
  // "…of Pakistan", "…of the Congo": a proper noun after of/in scopes the
  // list to a place or an organisation, which is never the puzzle category.
  /\bof\s+(the\s+)?[A-Z]/,
];

/** Titles that are usually exactly what a hunt wants. */
const TITLE_BOOST = [
  /\b(gods?|goddesses|deities|mytholog)/i,
  /\b(animals|birds|fish|insects|mammals|reptiles|trees|flowers|plants|herbs|spices|fruits|vegetables|mushrooms)\b/i,
  /\b(colors|colours|gemstones|minerals|metals|elements)\b/i,
  /\b(instruments|dances|genres|games|sports|hobbies)\b/i,
  /\b(languages|alphabets|scripts|currencies|units)\b/i,
  /\b(constellations|planets|moons|stars)\b/i,
  /\b(emotions|phobias|virtues|sins|fallacies)\b/i,
  /\b(dishes|foods|cheeses|breads|cocktails|drinks|wines)\b/i,
  /\b(breeds|varieties)\b/i,
  /\b(tools|weapons|garments|fabrics|knots|shapes|polygons)\b/i,
  /\b(occupations|professions|titles|ranks)\b/i,
];

function titleScore(subject) {
  let score = 0;
  for (const re of TITLE_REJECT) if (re.test(subject)) score -= 3;
  for (const re of TITLE_BOOST) if (re.test(subject)) score += 3;
  // Short subjects are general categories; long ones are qualified ones.
  score += Math.max(-2, 2 - Math.floor(subject.split(" ").length / 2));
  return score;
}

/** "List of Roman gods and goddesses" -> "romangods…"; stable and terse. */
function slugFor(subject, taken) {
  const words = normalize(subject)
    .split(" ")
    .filter((w) => !["of", "the", "in", "a", "an", "and", "or"].includes(w));
  let base = words.join("").slice(0, 28);
  if (!base) base = "list";
  let slug = base;
  for (let n = 2; taken.has(slug); ++n) slug = `${base}${n}`;
  taken.add(slug);
  return slug;
}

// ---- harvest ----

let candidatesCached = null;
if (CACHE && fs.existsSync(CACHE)) {
  process.stderr.write(`reading cached harvest from ${CACHE}\n`);
  candidatesCached = JSON.parse(fs.readFileSync(CACHE, "utf8"));
}

process.stderr.write(candidatesCached ? "" : `streaming ${DUMP}…\n`);
const proc = candidatesCached
  ? null
  : spawn("lbzip2", ["-dc", DUMP], { stdio: ["ignore", "pipe", "ignore"] });
const candidates = candidatesCached?.candidates ?? [];
const inlinks = new Map(candidatesCached?.inlinks ?? []);
if (!candidatesCached) {
const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
const LINK = /\[\[List of ([^\]|#]{1,70})[\]|#]/g;
let title = null;
let buf = null;
let scanned = 0;
for await (const line of rl) {
  // Cheap guard first: the regex is far too costly to run on 24 GB of prose.
  if (line.includes("[[List of ")) {
    LINK.lastIndex = 0;
    let m;
    while ((m = LINK.exec(line)) !== null) {
      const key = m[1].trim();
      inlinks.set(key, (inlinks.get(key) ?? 0) + 1);
    }
    // The tail is enormous — most "[[List of …]]" targets are linked exactly
    // once, often from a redirect or a malformed link, and holding them all
    // exhausts the heap long before the dump ends. They are also precisely
    // the lists this signal is meant to rank last, so dropping them costs
    // nothing: a list that reappears later starts counting again from one.
    if (inlinks.size > 1_500_000) {
      for (const [k, n] of inlinks) if (n === 1) inlinks.delete(k);
      process.stderr.write(`  pruned singleton links, ${inlinks.size} kept\n`);
    }
  }
  const t = /<title>List of ([^<]{1,70})<\/title>/.exec(line);
  if (t) {
    title = t[1];
    buf = [];
    continue;
  }
  if (title === null) continue;
  if (line.includes("</page>")) {
    ++scanned;
    // Judge the title *before* keeping the entries. Reading table rows as well
    // as bullets multiplies the candidate set several-fold, and holding every
    // "List of townships in …" long enough to score it exhausts even a 24 GB
    // heap. The title alone is enough to know those are out.
    const keep = titleScore(title) > -2;
    const entries = keep ? entriesFrom(buf ?? []) : [];
    if (entries.length >= 8 && entries.length <= 600) {
      candidates.push({ subject: title, entries });
    }
    title = null;
    buf = null;
    continue;
  }
  if (buf.length < 4000) buf.push(line);
}

process.stderr.write(`${scanned} list pages, ${candidates.length} with usable entries\n`);
process.stderr.write(`${inlinks.size} distinct list pages were linked to\n`);
if (CACHE) {
  fs.writeFileSync(CACHE, JSON.stringify({ candidates, inlinks: [...inlinks] }));
  process.stderr.write(`cached harvest to ${CACHE}\n`);
}
}

// ---- corpus coverage ----

const { MemorySource } = await import("../src/byte-source.js");
const { IndexReader } = await import("../src/index-reader.js");
const { makeWordChecker } = await import("../src/index-words.js");

const reader = await IndexReader.open(new MemorySource(fs.readFileSync(INDEX)));
const isWord = makeWordChecker(reader);
const known = async (e) => {
  const r = isWord(e);
  return r instanceof Promise ? await r : r;
};

process.stderr.write("scoring against the corpus…\n");
for (const c of candidates) {
  const sample = c.entries.slice(0, 40);
  let hits = 0;
  for (const e of sample) if (await known(e)) ++hits;
  c.coverage = hits / sample.length;
  c.title = titleScore(c.subject);
  c.inlinks = inlinks.get(c.subject) ?? 0;
  // Importance is how much the encyclopedia refers to the list; coverage is
  // whether its members are words the corpus knows. A list needs both: a
  // famous list of unsearchable names is no use, and neither is an obscure
  // list of common ones. Logs, because inlink counts are heavy-tailed.
  // Weights, after looking at what each signal actually promotes. Coverage
  // leads because an unsearchable list is worthless whatever its fame; links
  // break ties between lists the corpus knows equally well; the title term is
  // doubled because a single "winners"/"championship" tell is enough to know
  // a list is about events rather than a category.
  c.score = c.coverage * 9 + Math.log10(1 + c.inlinks) * 3 + c.title * 2;
}

candidates.sort((a, b) => b.score - a.score);
const chosen = candidates
  .filter((c) => c.coverage >= 0.5 && c.score >= MIN_SCORE)
  .slice(0, TOP);

if (SAMPLE) {
  console.log(`\n--- top 30 of ${chosen.length} ---`);
  for (const c of chosen.slice(0, 30)) {
    console.log(
      `  ${c.score.toFixed(1).padStart(5)}  links=${String(c.inlinks).padStart(5)}  cov=${(c.coverage * 100).toFixed(0).padStart(3)}%  n=${String(c.entries.length).padStart(3)}  ${c.subject}`,
    );
  }
  console.log(`\n--- 15 at the cut ---`);
  for (const c of chosen.slice(-15)) {
    console.log(
      `  ${c.score.toFixed(1).padStart(5)}  links=${String(c.inlinks).padStart(5)}  cov=${(c.coverage * 100).toFixed(0).padStart(3)}%  n=${String(c.entries.length).padStart(3)}  ${c.subject}`,
    );
  }
  console.log(`\nchosen ${chosen.length}, total entries ${chosen.reduce((n, c) => n + c.entries.length, 0)}`);
  process.exit(0);
}

// ---- write ----
// One list per line: slug, a tab, then comma-separated entries. Entries are
// already in corpus form, so the runtime does no work beyond splitting.

const taken = new Set();
const lines = [];
for (const c of chosen) {
  const slug = slugFor(c.subject, taken);
  lines.push(`${slug}\t${c.subject}\t${c.entries.join(",")}`);
}
lines.sort();
fs.writeFileSync(OUT, lines.join("\n") + "\n");
const bytes = fs.statSync(OUT).size;
process.stderr.write(
  `wrote ${OUT}: ${chosen.length} lists, ` +
    `${chosen.reduce((n, c) => n + c.entries.length, 0)} entries, ` +
    `${(bytes / 1024).toFixed(0)} KB\n`,
);
