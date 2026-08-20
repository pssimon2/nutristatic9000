// One shard of a `find-expr --shards N` run: walk the index owning only
// the seed letters given, and report every raw match. The parent merges the
// shards and runs the predicates — this thread only walks.

import { parentPort, workerData } from "node:worker_threads";
import { SessionContext } from "../src/session-context.js";
import { compileQuery, makeDriver } from "../src/find-expr.js";
import { cliOpenIndex, loadDatasetsFromDisk } from "../src/node-io.js";

interface ShardJob {
  indexPath: string;
  pattern: string;
  seedLetters: number[];
  maxSteps: number;
  scoreFloor: number;
}

const job = workerData as ShardJob;

const ctx = new SessionContext();
// Silent-on-missing is fine here too: the parent already reported it.
loadDatasetsFromDisk(ctx, job.pattern, new URL("../web/public/", import.meta.url));

const reader = await cliOpenIndex(job.indexPath);
const driver = makeDriver(reader, compileQuery(job.pattern, ctx), undefined, {
  scoreFloor: job.scoreFloor,
  seedLetters: job.seedLetters,
});

const batch: Array<{ score: number; text: string }> = [];
let steps = 0;
let hitLimit = false;
for (;;) {
  if (job.maxSteps > 0 && steps >= job.maxSteps) {
    hitLimit = true;
    break;
  }
  ++steps;
  let r = driver.step();
  if (r instanceof Promise) r = await r;
  if (r) {
    if (driver.text === null) break;
    batch.push({ score: driver.score, text: driver.text.replace(/ +$/, "") });
    if (batch.length >= 1000) {
      parentPort!.postMessage({ results: batch.splice(0) });
    }
  }
}
parentPort!.postMessage({
  results: batch,
  done: true,
  steps,
  hitLimit,
  frontierPeak: driver.frontierPeak,
});
