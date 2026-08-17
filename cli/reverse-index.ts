// Build the reverse-index sidecar (F7): every stored phrase reversed, as an
// ordinary .index file. Serve it beside the original and hand it to
// `find-expr --reverse-index` for suffix-anchored patterns.

import * as fs from "node:fs";
import { cliOpenIndex } from "../src/node-io.js";
import { BufferSink } from "../src/index-writer.js";
import { buildReverseIndex } from "../src/reverse.js";

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length > 4) {
  console.error("usage: reverse-index input.index output.rindex");
  process.exit(2);
}

const reader = await cliOpenIndex(input);
const sink = new BufferSink();
const entries = await buildReverseIndex(reader, sink);
fs.writeFileSync(output, sink.bytes());
console.error(`# ${entries} entries reversed into ${output}`);
