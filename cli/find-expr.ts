// Port of upstream find-expr.cpp + search-printer.cpp: stream results for an
// expression against an index, with '# N' progress lines every 100k steps.

import { compileQuery, formatScore, makeDriver, ParseError } from "../src/find-expr.js";
import { cliOpenIndex } from "../src/node-io.js";
import {
  type ExtractSpec,
  type RankSpec,
  applyExtract,
  parseExtract,
  parseRank,
} from "../src/extract-spec.js";
import {
  type FilterSpec,
  isPalindrome,
  letters,
  parseFilterWrapper,
  reversed,
} from "../src/result-filter.js";
import fs from "node:fs";
import { splitWords } from "../src/compound.js";
import {
  needsPhonetics,
  parsePhonetics,
  setPhonetics,
} from "../src/phonetics.js";
import {
  needsThesaurus,
  parseThesaurus,
  setThesaurus,
} from "../src/thesaurus.js";
import { makeWordChecker } from "../src/index-words.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const USAGE =
  "usage: find-expr [--max-steps N] input.index expression\n" +
  "  N: step limit (default 1000000; 0 = unlimited)";

const args = process.argv.slice(2);
// Same default computation limit as the upstream website; upstream's CLI
// instead runs unbounded, which exhausts memory on open-ended patterns.
let maxSteps = 1000000;
const flagIdx = args.indexOf("--max-steps");
if (flagIdx !== -1) {
  const raw = args[flagIdx + 1];
  // Strict: a typo'd value must not silently disable ("abc" -> NaN) or
  // destroy ("1e6" -> 1) the limit.
  if (raw === undefined || !/^\d+$/.test(raw)) {
    console.error(`error: bad --max-steps value "${raw ?? ""}"\n${USAGE}`);
    process.exit(2);
  }
  maxSteps = parseInt(raw, 10);
  args.splice(flagIdx, 2);
}
// The expression (last positional) may legitimately start with "-" (the
// optional-space operator), so only earlier args can be stray options.
const stray = args.slice(0, -1).find((a) => a.startsWith("-"));
if (stray !== undefined || args.length !== 2) {
  if (stray !== undefined) console.error(`error: unknown option "${stray}"`);
  console.error(USAGE);
  process.exit(2);
}
const [indexPath, expr] = args;

// The browser understands wrappers the engine doesn't: {at …} and {rank …}
// shape the output, {compound …}/{palindrome:…}/{reversible:…} ask the index
// about finished matches. Handle them here too, so the CLI and the site accept
// the same queries.
let pattern = expr;
let extract: ExtractSpec | null = null;
let rank: RankSpec | null = null;
let resultFilter: FilterSpec | null = null;
try {
  const ex = parseExtract(pattern);
  if (ex) {
    extract = ex.spec;
    pattern = ex.inner;
  }
  const rk = parseRank(pattern);
  if (rk) {
    rank = rk.spec;
    pattern = rk.inner;
  }
  const rf = parseFilterWrapper(pattern);
  if (rf) {
    resultFilter = rf.spec;
    pattern = rf.inner;
  }
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

// Compilation is synchronous, so load the pronouncing dictionary first when
// the query needs it. Ships next to the web assets.
for (const [needed, file, install] of [
  [needsPhonetics(pattern), "phonetics.txt", (t: string) => setPhonetics(parsePhonetics(t))],
  [needsThesaurus(pattern), "thesaurus.txt", (t: string) => setThesaurus(parseThesaurus(t))],
] as Array<[boolean, string, (t: string) => void]>) {
  if (!needed) continue;
  try {
    install(fs.readFileSync(new URL(`../web/public/${file}`, import.meta.url), "utf8"));
  } catch {
    // Left unloaded: the parser reports what is missing.
  }
}

let filter;
try {
  filter = compileQuery(pattern);
} catch (e) {
  if (e instanceof ParseError) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const reader = await cliOpenIndex(indexPath);
const driver = makeDriver(reader, filter);
const isWord = makeWordChecker(reader);
let rawRank = 0;

/**
 * Apply the output wrappers to one match: null drops it, otherwise the line
 * to print. Order matches the browser — corpus filter, then rank window, then
 * extraction.
 */
async function present(score: number, text: string): Promise<string | null> {
  let note = "";
  if (resultFilter) {
    if (resultFilter.kind === "compound") {
      const parts = await splitWords(text, resultFilter.pieces, isWord);
      if (!parts) return null;
      note = `  ${parts.join("·")}`;
    } else if (resultFilter.kind === "palindrome") {
      if (!isPalindrome(text)) return null;
    } else {
      const back = reversed(text);
      if (back === letters(text) || !(await isWord(back))) return null;
      note = `  ← ${back}`;
    }
  }
  ++rawRank;
  if (rank && (rawRank < rank.from || rawRank > rank.to)) return null;
  if (extract) {
    const picked = applyExtract(extract, text);
    if (picked === null) return null;
    return `${formatScore(score)} ${picked}  (${text})${note}`;
  }
  return `${formatScore(score)} ${text}${note}`;
}

try {
  let count = 0;
  for (;;) {
    if (maxSteps > 0 && count >= maxSteps) {
      process.stdout.write(`# computation limit reached (${count} steps)\n`);
      break;
    }
    if (++count % 100000 === 0) process.stdout.write(`# ${count}\n`);
    let r = driver.step();
    if (r instanceof Promise) r = await r;
    if (r) {
      if (driver.text === null) break;
      const text = driver.text.replace(/ +$/, "");
      const line = await present(driver.score, text);
      if (line !== null) process.stdout.write(`${line}\n`);
    }
  }
} catch (e) {
  // "pattern too complex" (filter state cap) or "index error: ..." — a
  // one-liner, not a stack trace.
  const message = e instanceof Error ? e.message : String(e);
  console.error(`error: ${message}`);
  process.exit(message.includes("pattern too complex") ? 2 : 1);
}
