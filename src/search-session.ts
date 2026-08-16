// Incremental search session shared by the web worker and any embedder:
// wraps compileQuery + SearchDriver with a resumable step budget, streaming
// results through a callback. Mirrors the upstream CGI's behavior of
// stopping at a computation limit that the user can raise ("try harder").

import { IndexReader } from "./index-reader.js";
import { compileQuery, DEFAULT_RESTART, makeDriver } from "./find-expr.js";
import { SessionContext } from "./session-context.js";
import { SearchDriver, SearchDriverOptions } from "./search-driver.js";

export interface SearchResult {
  score: number;
  text: string;
}

export type SessionStatus = "limit" | "results" | "exhausted";

export class SearchSession {
  private driver: SearchDriver;
  steps = 0;

  constructor(
    reader: IndexReader,
    query: string,
    ctx: SessionContext,
    restart = DEFAULT_RESTART,
    opts: SearchDriverOptions = {},
  ) {
    this.driver = makeDriver(reader, compileQuery(query, ctx), restart, opts);
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
    let results = 0;
    while (this.steps < maxSteps && results < maxResults) {
      if (++this.steps % 100000 === 0) onProgress?.(this.steps);
      // Yield to the event loop periodically so stop messages get through.
      if (this.steps % 20000 === 0 && shouldYield) {
        const y = shouldYield();
        if (y instanceof Promise) await y;
      }
      if (shouldStop && this.steps % 2000 === 0 && shouldStop()) return "limit";
      let r = this.driver.step();
      if (r instanceof Promise) r = await r;
      if (r) {
        if (this.driver.text === null) return "exhausted";
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
