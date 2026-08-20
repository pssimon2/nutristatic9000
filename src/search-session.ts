// Incremental search session shared by the web worker and any embedder:
// wraps compileQuery + SearchDriver with a resumable step budget, streaming
// results through a callback. Mirrors the Nutrimatic CGI's behavior of
// stopping at a computation limit that the user can raise ("try harder").

import { IndexReader } from "./index-reader.js";
import { compileConjuncts, DEFAULT_RESTART, makeDriver } from "./find-expr.js";
import type { Conjunct } from "./conjunct.js";
import { makeFilter } from "./expr-filter.js";
import {
  type FiniteResult,
  finiteStrategy,
} from "./finite-strategy.js";
import { SessionContext } from "./session-context.js";
import { SearchDriver, SearchDriverOptions } from "./search-driver.js";
import { Filter, FilterCache, FilterCapacityError } from "./expr-filter.js";
import { Emptiness, languageEmptiness } from "./emptiness.js";
import { SourceStats, Stats, emptyStats } from "./stats.js";

export interface SearchResult {
  score: number;
  text: string;
}

/**
 * How often to report progress when steps alone would not trigger it.
 *
 * Often enough that a panel watching a slow search looks alive, rarely enough
 * that the message traffic is nothing next to a network fetch.
 */
const PROGRESS_MS = 250;

export type SessionStatus =
  | "limit"
  | "results"
  | "exhausted"
  | "complex"
  /** The pattern cannot match anything; no search was run. */
  | "empty";

export class SearchSession {
  private driver: SearchDriver;
  private readonly filter: Filter;
  private readonly source: SourceStats;
  steps = 0;
  results = 0;
  /** Result-predicate outcomes, reported by whoever runs them. */
  predicateChecks = 0;
  predicatePassed = 0;

  /**
   * `query` may be an already-compiled `Filter` instead of the text to
   * compile, so a caller that has one need not build it twice — and so the
   * capacity path can be tested without a query that takes eight million
   * steps to fill the automaton.
   */
  constructor(
    reader: IndexReader,
    query: string | Filter,
    ctx: SessionContext,
    restart = DEFAULT_RESTART,
    opts: SearchDriverOptions & {
      /**
       * Force the trie walk even where testing a list would apply. For
       * comparing the two — they are meant to give identical answers, and a
       * way to run both is how that stays true.
       */
      forceWalk?: boolean;
      /**
       * A per-conjunct filter cache owned by the caller, so a session's
       * shared conjuncts reuse the lazy DFAs a previous query built.
       */
      filterCache?: FilterCache;
    } = {},
  ) {
    this.forceWalk = opts.forceWalk === true;
    // Kept, not discarded into the filter: a query with one small finite
    // conjunct can be answered by testing that list rather than walking the
    // index, and the list is the conjunct. A caller that hands over a
    // ready-made Filter has no conjuncts to offer, and gets the walk.
    this.conjuncts =
      typeof query === "string" ? compileConjuncts(query, ctx) : null;
    this.filter =
      this.conjuncts === null
        ? (query as Filter)
        : makeFilter(this.conjuncts, opts.filterCache);
    this.reader = reader;
    this.source = reader.source as SourceStats;
    this.driver = makeDriver(reader, this.filter, restart, opts);
  }

  private readonly forceWalk: boolean;
  private readonly conjuncts: Conjunct[] | null;
  private readonly reader: IndexReader;
  /** Results from the finite strategy, once it has been tried. */
  private finite: FiniteResult[] | null = null;
  /** What testing cost, for stats(): a walk's numbers describe none of it. */
  private finiteCandidates = 0;
  private finiteLookups = 0;
  private finiteTried = false;
  /** How many of them have been handed over, so a "continue" resumes. */
  private finiteAt = 0;

  /**
   * What the search has cost so far. Gathered from the pieces that already
   * keep the numbers rather than accumulated during the walk — see stats.ts.
   */
  stats(): Stats {
    const s = emptyStats();
    s.steps = this.steps;
    s.results = this.results;
    s.frontierPeak = this.driver.frontierPeak;
    s.dfaStates = this.filter.stateCount;
    s.bytesFetched = this.source.bytesFetched ?? 0;
    s.requests = this.source.requests ?? 0;
    s.chunkHits = this.source.chunkHits ?? 0;
    s.chunkMisses = this.source.chunkMisses ?? 0;
    s.predicateChecks = this.predicateChecks;
    s.predicatePassed = this.predicatePassed;
    s.candidatesTested = this.finiteCandidates;
    s.indexLookups = this.finiteLookups;
    return s;
  }

  /**
   * Run until `maxSteps` total steps have been taken ("limit"), `maxResults`
   * more results arrive ("results"), or the search space is exhausted.
   * Calls `onResult` for each match (trailing spaces stripped). Re-invoke
   * with a higher maxSteps to "try harder".
   */
  async run(
    maxSteps: number,
    maxResults: number,
    onResult: (r: SearchResult) => void,
    onProgress?: (steps: number) => void,
    shouldYield?: () => void | Promise<void>,
    // Optional early stop (range mode caps on bytes-fetched / wall-clock time
    // rather than step count — a cached step is free, a fetched step is a
    // round-trip, so steps are a poor cost proxy). Returns "limit" when it
    // fires, so callers treat it like the step budget being hit.
    shouldStop?: () => boolean,
  ): Promise<SessionStatus> {
    if (this.outOfStates) return "complex";
    // Everything that can intern a lazy DFA state lives inside this try, not
    // just the walk: the emptiness probe and the finite strategy drive the
    // same filter, and the worker's FilterCache hands back a filter that a
    // previous query may have left sitting exactly at the cap — so the very
    // first transition of a retry can be the one that overflows. Catching it
    // only around the walk turned "this pattern is too complex" into a raw
    // error on the retry, permanently.
    try {
      // Before walking the index at all: some patterns cannot match anything,
      // and the walk has no way to discover that except by exhausting its
      // budget. `A{5}&A{6}` spent a million steps and ~950ms proving it, then
      // offered a "try harder" button. The automaton settles it in about forty
      // states. Bounded, and "unknown" (a genuinely large automaton) falls
      // through to the search exactly as before.
      this.canMatch ??= languageEmptiness(this.filter);
      if (this.canMatch === "empty") return "empty";

      // A small finite conjunct is a list, and a list can be tested rather than
      // searched for — same answers, same order, same scores, and the index
      // touched once per survivor instead of once per node. Null means the
      // query is not that shape, which is the common case.
      if (!this.finiteTried && this.conjuncts !== null && !this.forceWalk) {
        this.finiteTried = true;
        const run = await finiteStrategy(this.reader, this.conjuncts);
        if (run !== null) {
          this.finite = run.results;
          this.finiteCandidates = run.candidates;
          this.finiteLookups = run.lookups;
        }
      }
      if (this.finite !== null) {
        let n = 0;
        while (this.finiteAt < this.finite.length && n < maxResults) {
          const r = this.finite[this.finiteAt++];
          onResult({ score: r.score, text: r.text });
          ++n;
          ++this.results;
        }
        return this.finiteAt >= this.finite.length ? "exhausted" : "results";
      }

      return await this.walk(maxSteps, maxResults, onResult, onProgress, shouldYield, shouldStop);
    } catch (e) {
      if (!(e instanceof FilterCapacityError)) throw e;
      // The lazy DFA is full. Every result already handed to `onResult` is
      // correct — the automaton was right up to the state it could not build
      // — so the run ends here rather than failing. The flag makes a later
      // "keep searching" say so immediately instead of rebuilding to the same
      // wall and throwing again.
      this.outOfStates = true;
      return "complex";
    }
  }

  /** True once the filter has run out of lazy DFA states. */
  private outOfStates = false;

  /** Cached: asked once per session, not once per "try harder". */
  private canMatch: Emptiness | null = null;

  private async walk(
    maxSteps: number,
    maxResults: number,
    onResult: (r: SearchResult) => void,
    onProgress?: (steps: number) => void,
    shouldYield?: () => void | Promise<void>,
    shouldStop?: () => boolean,
  ): Promise<SessionStatus> {
    let results = 0;
    // Progress on a clock as well as on a step count. Steps are a wildly
    // variable unit of time: in memory a hundred thousand of them take a
    // moment, but over a streamed index a *single* step can be a round trip —
    // measured, 384 steps in seven seconds — so a step-count trigger meant the
    // debug panel never updated at all on exactly the searches worth watching.
    let lastProgressAt = Date.now();
    while (this.steps < maxSteps && results < maxResults) {
      ++this.steps;
      if (this.steps % 100000 === 0) {
        lastProgressAt = Date.now();
        onProgress?.(this.steps);
      } else if (onProgress && (this.steps & 15) === 0) {
        // The clock read is masked for the same reason the limiter's is: this
        // runs once per step. Every 16 rather than every 64, because over the
        // network 64 steps can be a second and the panel should not be a
        // second behind what it is describing; in memory the step-count
        // trigger above fires first anyway, so the extra reads cost nothing.
        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_MS) {
          lastProgressAt = now;
          onProgress(this.steps);
        }
      }
      // Yield to the event loop periodically so stop messages get through.
      if (this.steps % 20000 === 0 && shouldYield) {
        const y = shouldYield();
        if (y instanceof Promise) await y;
      }
      // Every step, not every 2,000. A step is a cheap unit of *work* and a
      // wildly variable unit of *cost*: locally it is a memory read, but in
      // range mode one step can pull a ~440 KB chunk over the network. Asking
      // only every 2,000 steps meant the byte budget was first consulted long
      // after it was gone — measured on the deployed site, 179.7 MB fetched
      // against a 32 MB cap before the first check, on a query that then
      // reported no results. The predicate is a field read and a compare; the
      // caller is responsible for making its own clock check cheap.
      if (shouldStop && shouldStop()) return "limit";
      let r = this.driver.step();
      if (r instanceof Promise) r = await r;
      if (r) {
        if (this.driver.text === null) return "exhausted";
        ++this.results;
        onResult({
          score: this.driver.score,
          text: this.driver.text.replace(/ +$/, ""),
        });
        ++results;
      }
    }
    return this.steps >= maxSteps ? "limit" : "results";
  }
}
