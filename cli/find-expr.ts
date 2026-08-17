// Port of upstream find-expr.cpp + search-printer.cpp: stream results for an
// expression against an index, with '# N' progress lines every 100k steps.

import { compileQuery, formatScore, makeDriver, ParseError } from "../src/find-expr.js";
import { FilterCapacityError } from "../src/expr-filter.js";
import { cliOpenIndex } from "../src/node-io.js";
import { applyExtract } from "../src/extract-spec.js";
import fs from "node:fs";
import { SessionContext } from "../src/session-context.js";
import { providersFor } from "../src/data-providers.js";
import { applyResultFilters } from "../src/result-predicate.js";
import { makeWordChecker } from "../src/index-words.js";
import {
  SourceStats,
  emptyStats,
  formatStats,
} from "../src/stats.js";
import { formatPlan, planSlotQueries } from "../src/plan.js";
import { OutputTransform } from "../src/output.js";
import { type SlotPlan, planSlots } from "../src/slot-plan.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const USAGE =
  "usage: find-expr [--max-steps N] [--stats] [--explain] input.index expression\n" +
  "  N: step limit (default 1000000; 0 = unlimited), applied per slot\n" +
  "  expression: a pattern, or several separated by ';' — each runs in turn,\n" +
  "    and if they say where their letters come from ({at 1:…}) the assembled\n" +
  "    letters are printed after the last one";

const args = process.argv.slice(2);
const wantStats = args.includes("--stats");
if (wantStats) args.splice(args.indexOf("--stats"), 1);
const wantExplain = args.includes("--explain");
if (wantExplain) args.splice(args.indexOf("--explain"), 1);
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
// about finished matches, and ";" asks for several patterns at once. Handle
// them here too, so the CLI and the site accept the same queries — planSlots
// owns the whole peel, in the same order, for both.
let slots: SlotPlan[];
try {
  slots = planSlots(expr, 12);
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

// Compilation is synchronous, so load the pronouncing dictionary first when
// the query needs it. Ships next to the web assets.
// Checked against `expr`, not `pattern`: a {syllables …}/{stress …} wrapper
// has already been stripped out of the latter.
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

if (wantExplain) {
  // Before the search, and on stderr: this describes what is about to run.
  try {
    // One plan per slot: planning the whole string fails on the wrappers,
    // which insist on covering what they wrap.
    for (const plan of planSlotQueries(expr, ctx)) {
      for (const line of formatPlan(plan)) console.error(`# ${line}`);
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

const reader = await cliOpenIndex(indexPath);
const isWord = makeWordChecker(reader);

/** The stats a slot's run accumulated, so several runs can be summarised. */
interface SlotRun {
  /** The top match, for the assembled extraction line. */
  best: string | null;
  steps: number;
  emitted: number;
  frontierPeak: number;
  dfaStates: number;
  predicateChecks: number;
  predicatePassed: number;
  /** Set when the step limit stopped it rather than the search finishing. */
  hitLimit: boolean;
}

/**
 * Run one slot to the step limit, printing its results as they are found.
 *
 * The limit is per slot, matching the page: a reader who writes a dozen
 * patterns asked for a dozen searches, and making them share one budget would
 * mean the last few never ran.
 */
async function runSlot(slot: SlotPlan): Promise<SlotRun> {
  let filter;
  try {
    filter = compileQuery(slot.pattern, ctx);
  } catch (e) {
    if (e instanceof ParseError) {
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  const driver = makeDriver(reader, filter);
  const output = new OutputTransform(slot.extract, slot.rank);
  const run: SlotRun = {
    best: null,
    steps: 0,
    emitted: 0,
    frontierPeak: 0,
    dfaStates: 0,
    predicateChecks: 0,
    predicatePassed: 0,
    hitLimit: false,
  };

  /**
   * Apply the output wrappers to one match: null drops it, otherwise the line
   * to print. Order matches the browser — corpus filter, then rank window,
   * then extraction.
   */
  async function present(score: number, text: string): Promise<string | null> {
    let note = "";
    if (slot.filters.length > 0) {
      ++run.predicateChecks;
      // Same rule as the browser (src/result-predicate.ts); only the
      // formatting differs — a line suffix here, a `note` field over
      // postMessage there.
      const verdict = await applyResultFilters(slot.filters, text, ctx, isWord);
      if (!verdict.keep) return null;
      ++run.predicatePassed;
      if (verdict.notes.length > 0) note = `  ${verdict.notes.join("  ")}`;
    }
    const shown = output.apply(text);
    if (shown === null) return null;
    // The first match to survive every wrapper is what this slot contributes.
    run.best ??= text;
    return shown.source === null
      ? `${formatScore(score)} ${shown.text}${note}`
      : `${formatScore(score)} ${shown.text}  (${shown.source})${note}`;
  }

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
      const line = await present(driver.score, text);
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
  const runs: SlotRun[] = [];
  for (const slot of slots) {
    // Only when there is more than one, so a plain query's output is byte for
    // byte what it always was — anything piping this reads the result stream.
    if (slots.length > 1) process.stdout.write(`# slot ${runs.length + 1}: ${slot.query}\n`);
    runs.push(await runSlot(slot));
  }

  // The payoff line: what each slot contributes, in order. Only when a slot
  // says where its letter comes from — otherwise there is nothing to assemble.
  if (slots.length > 1 && slots.some((s) => s.extract)) {
    const picked = slots.map((s, i) => {
      const best = runs[i].best;
      // "?" for a slot that found nothing: the line still lines up with the
      // slots, and a gap is more useful than a shorter string.
      if (!s.extract || best === null) return "?";
      return applyExtract(s.extract, best) ?? "?";
    });
    process.stdout.write(`${picked.join("")}\n`);
  }

  if (wantStats) {
    const src = reader.source as SourceStats;
    const s = emptyStats();
    // Summed across slots: one query, one summary. The source counters are
    // lifetime totals for the index, so they already cover every slot.
    s.steps = runs.reduce((a, r) => a + r.steps, 0);
    s.results = runs.reduce((a, r) => a + r.emitted, 0);
    s.frontierPeak = Math.max(0, ...runs.map((r) => r.frontierPeak));
    s.dfaStates = Math.max(0, ...runs.map((r) => r.dfaStates));
    s.bytesFetched = src.bytesFetched ?? 0;
    s.requests = src.requests ?? 0;
    s.chunkHits = src.chunkHits ?? 0;
    s.chunkMisses = src.chunkMisses ?? 0;
    s.predicateChecks = runs.reduce((a, r) => a + r.predicateChecks, 0);
    s.predicatePassed = runs.reduce((a, r) => a + r.predicatePassed, 0);
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
