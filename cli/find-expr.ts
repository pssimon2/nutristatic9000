// Port of upstream find-expr.cpp + search-printer.cpp: stream results for an
// expression against an index, with '# N' progress lines every 100k steps.

import {
  compileConjuncts,
  compileQuery,
  formatScore,
  makeDriver,
  ParseError,
} from "../src/find-expr.js";
import { finiteStrategy } from "../src/finite-strategy.js";
import { derivedNote } from "../src/match-notes.js";
import { FilterCapacityError } from "../src/expr-filter.js";
import { cliOpenIndex } from "../src/node-io.js";
import fs from "node:fs";
import { SessionContext } from "../src/session-context.js";
import { providersFor } from "../src/data-providers.js";
import { applyResultFilters } from "../src/result-predicate.js";
import { type FilterSpec, parseFilterWrappers } from "../src/result-filter.js";
import { type QueryShape, shapeOfQuery } from "../src/query-shape.js";
import { makeWordChecker } from "../src/index-words.js";
import { parseRemoteList, remoteListUrls } from "../src/word-lists.js";
import { installPack, parsePack } from "../src/packs.js";
import { MergedDriver } from "../src/merged-driver.js";
import {
  SourceStats,
  emptyStats,
  formatStats,
} from "../src/stats.js";
import { formatPlan, planQuery } from "../src/plan.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const USAGE =
  "usage: find-expr [--max-steps N] [--stats] [--explain] a.index[,b.index...] expression\n" +
  "  several comma-separated indexes merge into one normalized result stream\n" +
  "  N: step limit (default 1000000; 0 = unlimited)\n" +
  "  --walk: always walk the index, even where testing a list would do\n" +
  "  --score-floor F: drop frontier entries below F x the best score seen\n" +
  "    (e.g. 1e-9) - bounds frontier growth, truncates the deep tail\n" +
  "  --pack FILE|URL: load a construct pack (repeatable)\n" +
  "  --shards N: split the walk across N threads by first letter;\n" +
  "    results merge exactly, printed once every shard finishes\n" +
  "  --reverse-index FILE: walk this reversed sidecar instead - the\n" +
  "    win for suffix-anchored patterns like .*tion; results read forward";

const args = process.argv.slice(2);
const forceWalk = args.includes("--walk");
if (forceWalk) args.splice(args.indexOf("--walk"), 1);
const wantStats = args.includes("--stats");
if (wantStats) args.splice(args.indexOf("--stats"), 1);
const wantExplain = args.includes("--explain");
if (wantExplain) args.splice(args.indexOf("--explain"), 1);
// Same default computation limit as the upstream website; upstream's CLI
// instead runs unbounded, which exhausts memory on open-ended patterns.
const packRefs: string[] = [];
for (let i = args.indexOf("--pack"); i !== -1; i = args.indexOf("--pack")) {
  const ref = args[i + 1];
  if (ref === undefined) {
    console.error(`error: --pack needs a file or URL\n${USAGE}`);
    process.exit(2);
  }
  packRefs.push(ref);
  args.splice(i, 2);
}
let reverseIndexPath: string | null = null;
const revIdx = args.indexOf("--reverse-index");
if (revIdx !== -1) {
  const raw = args[revIdx + 1];
  if (raw === undefined) {
    console.error(`error: --reverse-index needs a file\n${USAGE}`);
    process.exit(2);
  }
  reverseIndexPath = raw;
  args.splice(revIdx, 2);
}
let shardCount = 1;
const shardsIdx = args.indexOf("--shards");
if (shardsIdx !== -1) {
  const raw = args[shardsIdx + 1];
  if (raw === undefined || !/^\d+$/.test(raw) || +raw < 1 || +raw > 64) {
    console.error(`error: bad --shards value "${raw ?? ""}"\n${USAGE}`);
    process.exit(2);
  }
  shardCount = +raw;
  args.splice(shardsIdx, 2);
}
let scoreFloor = 0;
const floorIdx = args.indexOf("--score-floor");
if (floorIdx !== -1) {
  const raw = args[floorIdx + 1];
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!(parsed >= 0) || !isFinite(parsed)) {
    console.error(`error: bad --score-floor value "${raw ?? ""}"\n${USAGE}`);
    process.exit(2);
  }
  scoreFloor = parsed;
  args.splice(floorIdx, 2);
}
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

// The browser understands wrappers the engine doesn't: whole-query predicates
// like {palindrome:…} are peeled here and checked per match, exactly as the
// worker peels them on its side — so the CLI and the site accept the same
// queries.
let pattern: string;
let filters: FilterSpec[];
let shape: QueryShape;
try {
  const peeled = parseFilterWrappers(expr.trim());
  pattern = peeled.inner;
  filters = peeled.specs;
  shape = shapeOfQuery(pattern, 12);
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

// Compilation is synchronous, so load the pronouncing dictionary first when
// the query needs it. Ships next to the web assets.
const ctx = new SessionContext();

// One row per dataset (src/data-providers.ts); the CLI supplies only the part
// it alone knows — that they ship beside the web assets and are read from
// disk rather than fetched.
// Checked against `expr`, not the peeled pattern: a {syllables …}/{stress …}
// wrapper has already been stripped out of the latter.
for (const provider of providersFor(expr)) {
  try {
    const path = new URL(`../web/public/${provider.file}`, import.meta.url);
    if (provider.binary) {
      const buf = fs.readFileSync(path);
      provider.install(
        ctx,
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      );
    } else {
      provider.install(ctx, fs.readFileSync(path, "utf8"));
    }
  } catch {
    // Left unloaded: the parser reports what is missing.
  }
}

// Construct packs: files or URLs, installed before compiling.
for (const ref of packRefs) {
  try {
    const text = /^https?:\/\//.test(ref)
      ? await (await fetch(ref)).text()
      : fs.readFileSync(ref, "utf8");
    installPack(ctx, parsePack(JSON.parse(text)));
  } catch (e) {
    console.error(`error: pack ${ref}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

// Remote word lists: the CLI fetches them like the worker does.
for (const url of remoteListUrls(expr)) {
  try {
    const r = await fetch(url);
    if (r.ok) ctx.remoteLists.set(url, parseRemoteList(await r.text()));
  } catch {
    // The compile error explains what was needed.
  }
}

if (wantExplain) {
  // Before the search, and on stderr: this describes what is about to run.
  try {
    for (const line of formatPlan(planQuery(expr, ctx))) {
      console.error(`# ${line}`);
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

// Several indexes at once, comma-separated. Results merge in normalized
// score order, each tagged with the index it came from.
const indexPaths = indexPath.split(",").map((x) => x.trim()).filter((x) => x !== "");
const readers = await Promise.all(indexPaths.map((x) => cliOpenIndex(x)));
const reader = readers[0];
const checkers = readers.map((r) => makeWordChecker(r));
/** A word check over every index: a piece counts if any corpus knows it. */
const isWord: ReturnType<typeof makeWordChecker> = async (word, floor) => {
  for (const check of checkers) {
    if (await check(word, floor)) return true;
  }
  return false;
};
const labelOf = (x: string): string =>
  (x.split("/").pop() ?? x).replace(/\.index$/, "");

/** What the run accumulated, for the --stats summary. */
interface Run {
  steps: number;
  emitted: number;
  frontierPeak: number;
  dfaStates: number;
  predicateChecks: number;
  predicatePassed: number;
  /** Set when the step limit stopped it rather than the search finishing. */
  hitLimit: boolean;
  /** Set when this query was answered by testing a list, not by walking. */
  candidatesTested: number;
  indexLookups: number;
}

/**
 * One match through the predicates: null drops it, else the line to print.
 * Shared by the single-threaded walk and the sharded merge, counting into
 * whichever run is live.
 */
function presenter(run: Run) {
  return async function present(score: number, text: string): Promise<string | null> {
    let note = "";
    if (filters.length > 0) {
      ++run.predicateChecks;
      // Same rule as the browser (src/result-predicate.ts); only the
      // formatting differs — a line suffix here, a `note` field over
      // postMessage there.
      const verdict = await applyResultFilters(filters, text, ctx, isWord);
      if (!verdict.keep) return null;
      ++run.predicatePassed;
      if (verdict.notes.length > 0) note = `  ${verdict.notes.join("  ")}`;
    }
    // Derived from the query and the answer together — the Caesar shift that
    // matched, the letter an edit changed. Shared with the page, which is the
    // point: these were written where they were first needed and so the CLI
    // showed none of them.
    const derived = derivedNote(shape, text);
    if (derived !== null) note = note === "" ? `  ${derived}` : `${note}  ${derived}`;
    return `${formatScore(score)} ${text}${note}`;
  };
}

async function runQuery(): Promise<Run> {
  let filter;
  try {
    filter = compileQuery(pattern, ctx);
  } catch (e) {
    if (e instanceof ParseError) {
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  const run: Run = {
    steps: 0,
    emitted: 0,
    frontierPeak: 0,
    dfaStates: 0,
    predicateChecks: 0,
    predicatePassed: 0,
    hitLimit: false,
    candidatesTested: 0,
    indexLookups: 0,
  };

  const present = presenter(run);

  // A query with one small finite conjunct is a list, and a list can be
  // tested rather than searched for — same answers, same order, same scores.
  // See src/finite-strategy.ts; --walk forces the search, for comparing them.
  if (!forceWalk && readers.length === 1) {
    const tested = await finiteStrategy(reader, compileConjuncts(pattern, ctx));
    if (tested !== null) {
      run.candidatesTested = tested.candidates;
      run.indexLookups = tested.lookups;
      for (const r of tested.results) {
        const line = await present(r.score, r.text);
        if (line !== null) {
          ++run.emitted;
          process.stdout.write(`${line}\n`);
        }
      }
      return run;
    }
  }

  const driver =
    readers.length === 1
      ? makeDriver(reader, filter, undefined, { scoreFloor })
      : new MergedDriver(
          readers.map((r, i) => ({ reader: r, label: labelOf(indexPaths[i]) })),
          filter,
          undefined,
          { scoreFloor },
        );
  for (;;) {
    if (maxSteps > 0 && run.steps >= maxSteps) {
      process.stdout.write(`# computation limit reached (${run.steps} steps)\n`);
      run.hitLimit = true;
      break;
    }
    if (++run.steps % 100000 === 0) process.stdout.write(`# ${run.steps}\n`);
    let r = driver.step();
    if (r instanceof Promise) r = await r;
    if (r) {
      if (driver.text === null) break;
      const text = driver.text.replace(/ +$/, "");
      let line = await present(driver.score, text);
      if (line !== null) {
        if (driver instanceof MergedDriver) line += `  (${driver.source})`;
        ++run.emitted;
        process.stdout.write(`${line}\n`);
      }
    }
  }
  run.frontierPeak = driver.frontierPeak;
  run.dfaStates = filter.stateCount;
  return run;
}

/**
 * Run the walk across N threads, each owning a first-letter shard, and
 * merge exactly. Shards stream in descending order, so a K-way merge over
 * their finished result lists is the unsharded order; each result then goes
 * through the same predicates as a single-threaded run.
 */
async function runSharded(): Promise<Run> {
  const { Worker } = await import("node:worker_threads");
  const { shardSeedLetters } = await import("../src/shards.js");
  compileQuery(pattern, ctx); // fail fast, in this thread, with the real error
  const shards = await shardSeedLetters(reader, shardCount);
  const run: Run = {
    steps: 0, emitted: 0, frontierPeak: 0, dfaStates: 0,
    predicateChecks: 0, predicatePassed: 0, hitLimit: false,
    candidatesTested: 0, indexLookups: 0,
  };
  const present = presenter(run);
  const lists = await Promise.all(
    shards.map(
      (seedLetters) =>
        new Promise<Array<{ score: number; text: string }>>((resolve, reject) => {
          const worker = new Worker(new URL("./shard-worker.ts", import.meta.url), {
            workerData: {
              indexPath: indexPaths[0],
              pattern,
              seedLetters,
              maxSteps,
              scoreFloor,
            },
          });
          const mine: Array<{ score: number; text: string }> = [];
          worker.on("message", (m: { results: typeof mine; done?: boolean;
              steps?: number; hitLimit?: boolean; frontierPeak?: number }) => {
            mine.push(...m.results);
            if (m.done) {
              run.steps += m.steps ?? 0;
              run.frontierPeak += m.frontierPeak ?? 0;
              if (m.hitLimit) run.hitLimit = true;
              void worker.terminate();
              resolve(mine);
            }
          });
          worker.on("error", reject);
        }),
    ),
  );
  // K-way merge of descending lists.
  const at = lists.map(() => 0);
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; ++i) {
      if (at[i] >= lists[i].length) continue;
      if (best === -1 || lists[i][at[i]].score > lists[best][at[best]].score) {
        best = i;
      }
    }
    if (best === -1) break;
    const r = lists[best][at[best]++];
    const line = await present(r.score, r.text);
    if (line !== null) {
      ++run.emitted;
      process.stdout.write(`${line}\n`);
    }
  }
  if (run.hitLimit) {
    process.stdout.write(`# computation limit reached in a shard (${run.steps} steps total)\n`);
  }
  return run;
}

/**
 * Walk the reversed sidecar. The pattern's automata are reversed, the
 * walk prunes on what is now a prefix, and each match is re-reversed before
 * the predicates and the printout — same strings, same scores, read forward.
 */
async function runReversed(path: string): Promise<Run> {
  const { compileConjunctsReversed, unreverseText } = await import("../src/reverse.js");
  const { makeFilter } = await import("../src/expr-filter.js");
  compileQuery(pattern, ctx); // report pattern errors against the real query
  const revReader = await cliOpenIndex(path);
  const filter = makeFilter(compileConjunctsReversed(pattern, ctx));
  const run: Run = {
    steps: 0, emitted: 0, frontierPeak: 0, dfaStates: 0,
    predicateChecks: 0, predicatePassed: 0, hitLimit: false,
    candidatesTested: 0, indexLookups: 0,
  };
  const present = presenter(run);
  const driver = makeDriver(revReader, filter, undefined, { scoreFloor });
  for (;;) {
    if (maxSteps > 0 && run.steps >= maxSteps) {
      process.stdout.write(`# computation limit reached (${run.steps} steps)\n`);
      run.hitLimit = true;
      break;
    }
    if (++run.steps % 100000 === 0) process.stdout.write(`# ${run.steps}\n`);
    let r = driver.step();
    if (r instanceof Promise) r = await r;
    if (r) {
      if (driver.text === null) break;
      const line = await present(driver.score, unreverseText(driver.text));
      if (line !== null) {
        ++run.emitted;
        process.stdout.write(`${line}\n`);
      }
    }
  }
  run.frontierPeak = driver.frontierPeak;
  run.dfaStates = filter.stateCount;
  return run;
}

try {
  const run =
    reverseIndexPath !== null
      ? await runReversed(reverseIndexPath)
      : shardCount > 1 && readers.length === 1
        ? await runSharded()
        : await runQuery();

  if (wantStats) {
    const src = reader.source as SourceStats;
    const s = emptyStats();
    s.steps = run.steps;
    s.results = run.emitted;
    s.frontierPeak = run.frontierPeak;
    s.dfaStates = run.dfaStates;
    s.bytesFetched = src.bytesFetched ?? 0;
    s.requests = src.requests ?? 0;
    s.chunkHits = src.chunkHits ?? 0;
    s.chunkMisses = src.chunkMisses ?? 0;
    s.predicateChecks = run.predicateChecks;
    s.predicatePassed = run.predicatePassed;
    s.candidatesTested = run.candidatesTested;
    s.indexLookups = run.indexLookups;
    // On stderr: stdout is the result stream, and a caller piping it should
    // not have to filter the summary back out.
    for (const line of formatStats(s)) console.error(`# ${line}`);
  }
} catch (e) {
  // The filter's state cap or "index error: ..." — a one-liner, not a stack
  // trace. The cap is not a failed search: every result already on stdout was
  // found before the automaton ran out of room and is correct, so say that
  // rather than leaving a caller to assume the output is garbage. Exit 2
  // keeps it distinguishable from a real error for anything scripting this.
  if (e instanceof FilterCapacityError) {
    console.error(`# stopped: ${e.message}; results above are complete as far as it got`);
    process.exit(2);
  }
  const message = e instanceof Error ? e.message : String(e);
  console.error(`error: ${message}`);
  process.exit(1);
}
