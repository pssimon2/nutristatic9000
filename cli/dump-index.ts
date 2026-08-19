// Port of Nutrimatic dump-index.cpp: print every stored string with its count.

import { once } from "node:events";
import { IndexWalker } from "../src/index-walker.js";
import { cliOpenIndex } from "../src/node-io.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  // `dump-index big.index | head` is idiomatic; a closed pipe isn't an error.
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const path = process.argv[2];
if (!path || process.argv.length > 3) {
  console.error("usage: dump-index input.index");
  process.exit(2);
}

const reader = await cliOpenIndex(path);
try {
  const walker = await IndexWalker.create(reader, reader.root(), reader.count());
  const out: string[] = [];
  while (walker.text !== null) {
    out.push(`${String(walker.count).padStart(5)} [${walker.text}]`);
    if (out.length >= 10000) {
      // Respect backpressure: without the drain wait, piping a multi-GB dump
      // to a slow consumer buffers the entire output in RAM.
      if (!process.stdout.write(out.join("\n") + "\n")) {
        await once(process.stdout, "drain");
      }
      out.length = 0;
    }
    await walker.next();
  }
  if (out.length > 0) process.stdout.write(out.join("\n") + "\n");
} catch (e) {
  // Corrupt index mid-walk ("index error: ..."): one line, not a stack dump.
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
