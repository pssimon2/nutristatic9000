// Port of Nutrimatic make-index.cpp: read corpus text on stdin, write
// <prefix>.NNNNN.index files of sorted phrase windows.

import * as readline from "node:readline";
import { lineChains } from "../src/corpus.js";
import { IndexWriter, writeEntries } from "../src/index-writer.js";
import { FileSink } from "../src/node-io.js";

const CHAINS_PER_FILE = 1000000;
const TITLE_MULTIPLIER = 10;

const prefix = process.argv[2];
if (!prefix || prefix.startsWith("-") || process.argv.length > 3) {
  console.error("usage: make-index outfileprefix < textfile.txt");
  process.exit(2);
}

let fileCount = 0;
let chains: string[] = [];

function writeIndex(): void {
  const name = `${prefix}.${String(fileCount++).padStart(5, "0")}.index`;
  let sink: FileSink;
  try {
    // Exclusive: silently clobbering a previous (possibly partial) run's
    // chunks hides mixed-run corruption; the build scripts remove stale
    // chunks explicitly.
    sink = new FileSink(name, { exclusive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      console.error(
        `error: "${name}" already exists (remove stale chunks before rerunning)`,
      );
    } else {
      console.error(`error: can't write "${name}"`);
    }
    process.exit(1);
  }
  const writer = new IndexWriter(sink);
  writeEntries(writer, chains.map((c) => [c, 1]));
  sink.close();
  chains = [];
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let nextLineIsTitle = false;

rl.on("line", (line) => {
  // Handle both remove-markup output (BEGIN/END ARTICLE:) and
  // WikiExtractor output (<doc ...> ... </doc>).
  if (line.startsWith("BEGIN ARTICLE:")) {
    for (let i = 0; i < TITLE_MULTIPLIER; ++i) lineChains(line.slice(14), chains);
  } else if (line.startsWith("<doc ")) {
    nextLineIsTitle = true;
  } else if (nextLineIsTitle) {
    for (let i = 0; i < TITLE_MULTIPLIER; ++i) lineChains(line, chains);
    nextLineIsTitle = false;
  } else if (!line.startsWith("END ARTICLE:") && !line.startsWith("</doc>")) {
    lineChains(line, chains);
  }

  if (chains.length >= CHAINS_PER_FILE) writeIndex();
});

rl.on("close", () => {
  if (chains.length > 0) writeIndex();
});
