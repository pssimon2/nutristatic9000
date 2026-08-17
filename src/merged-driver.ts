// Multi-index merged search: one query over several indexes at once,
// results interleaved in true relevance order.
//
// Raw scores are occurrence counts scaled by restarts, so they are only
// comparable within one corpus — 100,000 hits in a 1.3-billion-token corpus
// is rarer than 20,000 in a 20-million one. Each driver's scores are
// normalized to its corpus size and rescaled to the largest corpus, so the
// merged stream reads like that corpus's own scores.
//
// The merge is exact: every per-index driver emits in descending order, so a
// K-way merge that holds one buffered result per driver always knows the
// global next. The cost is lookahead — a driver must reach its next result
// (or exhaustion) before the merge can commit — which is why `step()` here
// advances the *least-buffered* driver rather than all of them.
//
// A text found in several corpora is emitted once, at its best normalized
// score, with `source` naming the index it came from.

import { IndexReader } from "./index-reader.js";
import { Filter } from "./expr-filter.js";
import { SearchDriver, SearchDriverOptions } from "./search-driver.js";
import { DEFAULT_RESTART } from "./find-expr.js";

export interface MergedSource {
  reader: IndexReader;
  /** How to name this index in results ("en-wiki", "demo"). */
  label: string;
}

interface Lane {
  driver: SearchDriver;
  label: string;
  /** Raw→merged score multiplier: maxCorpus / thisCorpus. */
  norm: number;
  /** The next result this lane will contribute, once known. */
  pending: { text: string; score: number } | null;
  done: boolean;
}

export class MergedDriver {
  text: string | null = null;
  score = 0;
  /** Which index the last result came from. */
  source = "";

  private readonly lanes: Lane[];
  private readonly seen = new Set<string>();

  get frontierPeak(): number {
    let n = 0;
    for (const l of this.lanes) n += l.driver.frontierPeak;
    return n;
  }

  constructor(
    sources: MergedSource[],
    filter: Filter,
    restart = DEFAULT_RESTART,
    opts: SearchDriverOptions = {},
  ) {
    const maxCount = Math.max(...sources.map((s) => s.reader.count()));
    // One shared filter: its only mutation is memoisation, so lanes walking
    // it concurrently see one growing table instead of building three.
    this.lanes = sources.map((s) => ({
      driver: new SearchDriver(s.reader, filter, filter.startState, restart, opts),
      label: s.label,
      norm: maxCount / s.reader.count(),
      pending: null,
      done: false,
    }));
  }

  /**
   * Advance one step. True when there is news: a merged result, or overall
   * exhaustion (`text` null). One step here is one step of one lane.
   */
  step(): boolean | Promise<boolean> {
    const lane = this.lanes.find((l) => !l.done && l.pending === null);
    if (lane === undefined) return this.emit();
    const r = lane.driver.step();
    if (r instanceof Promise) return r.then((news) => this.absorb(lane, news));
    return this.absorb(lane, r);
  }

  private absorb(lane: Lane, news: boolean): boolean {
    if (!news) return false;
    if (lane.driver.text === null) {
      lane.done = true;
    } else {
      lane.pending = {
        text: lane.driver.text,
        score: lane.driver.score * lane.norm,
      };
    }
    // Emit only when every lane has shown its hand; until then, no result
    // can be known to be the global next.
    return this.lanes.some((l) => !l.done && l.pending === null)
      ? false
      : this.emit();
  }

  private emit(): boolean {
    let best: Lane | null = null;
    for (const l of this.lanes) {
      if (l.pending !== null && (best === null || l.pending.score > best.pending!.score)) {
        best = l;
      }
    }
    if (best === null) {
      this.text = null; // every lane exhausted
      this.score = 0;
      return true;
    }
    const { text, score } = best.pending!;
    best.pending = null;
    // The same text in a later corpus scores lower by construction (this is
    // the first, and the stream descends), so dropping duplicates keeps the
    // best reading.
    const key = text.replace(/ +$/, "");
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.text = text;
    this.score = score;
    this.source = best.label;
    return true;
  }
}
