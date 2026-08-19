// Port of Nutrimatic merge-indexes.cpp: merge sorted indexes with a frequency
// cutoff. usage: merge-indexes min input.index ... out.index

import * as fs from "node:fs";
import { IndexWalker } from "../src/index-walker.js";
import { IndexWriter } from "../src/index-writer.js";
import { mergeWalkers } from "../src/merge.js";
import { cliOpenIndex, FileSink } from "../src/node-io.js";

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("usage: merge-indexes min input.index ... out.index");
  process.exit(2);
}

// Strict digits only: Nutrimatic's atoi would turn "1e9" into cutoff 1 and
// silently merge with the wrong threshold.
if (!/^\d+$/.test(args[0]) || parseInt(args[0], 10) <= 0) {
  console.error(`error: illegal frequency threshold "${args[0]}"`);
  process.exit(2);
}
const cutoff = parseInt(args[0], 10);

const outPath = args[args.length - 1];
if (fs.existsSync(outPath)) {
  console.error(`error: output "${outPath}" already exists`);
  process.exit(1);
}

const walkers = [];
for (const path of args.slice(1, -1)) {
  // Chunk-cached source: dozens of multi-hundred-MB shards must not be
  // summed into RAM (128MB LRU per input).
  const reader = await cliOpenIndex(path, 1024);
  const walker = await IndexWalker.create(reader, reader.root(), reader.count());
  if (walker.text === null) {
    console.error(`warning: empty input "${path}"`);
  } else {
    walkers.push(walker);
  }
}

let sink: FileSink;
try {
  sink = new FileSink(outPath, { exclusive: true });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === "EEXIST") {
    console.error(`error: output "${outPath}" already exists`);
  } else {
    console.error(`error: can't write "${outPath}"`);
  }
  process.exit(1);
}
try {
  await mergeWalkers(walkers, cutoff, new IndexWriter(sink));
  sink.close();
} catch (e) {
  // Never leave a partial output behind: it would block the retry with
  // `output "..." already exists`.
  try {
    sink.close();
  } catch {
    // already closed
  }
  try {
    fs.unlinkSync(outPath);
  } catch {
    // best-effort cleanup
  }
  if (e instanceof Error && e.message === "empty leaf") {
    console.error(
      `error: no phrases meet the frequency cutoff (${cutoff}); no index written`,
    );
    process.exit(1);
  }
  throw e;
}
