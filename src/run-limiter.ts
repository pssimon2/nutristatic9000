// When to give up on a run that is reading the index over the network.
//
// Three caps, and they answer three different questions. Bytes: this has cost
// enough. Time: this has taken enough. Stall: this has stopped producing.
//
// The third is the one that pays. Over a streamed index the top of the answer
// comes from the head sidecar in well under a second, and what the index adds
// after that varies enormously — measured on the deployed English index,
// `A{5}&C*` went from 77 results to 1,027 over the following seventeen
// seconds, while `{palindrome:A{5}}` and `A{7}&.*zz.*` spent the whole
// twenty-second budget adding nothing at all. The walk was paying a round trip
// per region and finding none of them relevant. A page that says "searching…"
// for twenty seconds and then shows exactly what it showed at 0.8 s is worse
// than one that settles and offers to keep going.
//
// The stall threshold comes from the productive case rather than the wasteful
// one: `A{5}&C*`'s longest gap between results before the flood was 3.9 s, so
// anything comfortably above that leaves the searches worth continuing alone.
//
// `noteResult` is deliberately called for results that reach the reader, not
// for every match the automaton makes. A `{palindrome:…}` run matches
// candidates the whole time and shows none of them, and from the reader's side
// that is a search that has stopped producing.

export interface RunLimits {
  /** Stop after this many bytes fetched by this run. 0 disables. */
  byteBudget: number;
  /** Stop after this long. 0 disables. */
  timeMs: number;
  /** Stop when nothing has reached the reader for this long. 0 disables. */
  stallMs: number;
}

export interface RunLimiter {
  /** Consulted once per search step. */
  shouldStop(): boolean;
  /** Called when a result reaches the reader. */
  noteResult(): void;
}

/**
 * How often the clock is read, as a mask on the step counter.
 *
 * It was 1,024, on the reasoning that at any plausible step rate that is far
 * finer than the seconds being measured. That reasoning is wrong here, and
 * measurably: this only runs where the index is being fetched, and there a
 * step can be a round trip. `{palindrome:A{5}}` on the deployed index stopped
 * at exactly 1,024 steps — the first check — having spent 15 seconds and
 * 49.8 MB across 832 requests to get there. The cap was working perfectly and
 * could not be consulted.
 *
 * The cost it was avoiding does not exist: a limiter is only built when the
 * index is remote, so an in-memory or on-disk search never reads this clock.
 */
const CLOCK_MASK = 63;

/**
 * A limiter, or null when nothing is capped.
 *
 * `bytesFetched` is read rather than passed so the caller does not have to
 * thread the source's running total through every step; `now` is injected so
 * the behaviour can be tested without waiting for real seconds to pass.
 */
export function makeRunLimiter(
  bytesFetched: () => number,
  limits: RunLimits,
  now: () => number = Date.now,
): RunLimiter | null {
  const { byteBudget, timeMs, stallMs } = limits;
  if (byteBudget <= 0 && timeMs <= 0 && stallMs <= 0) return null;

  const startBytes = bytesFetched();
  const startTime = now();
  // A run that produces nothing at all is stopped on the same rule as one
  // that stops producing, so this starts at the run's start rather than at
  // the first result.
  let lastResult = startTime;
  let ticks = 0;

  return {
    shouldStop(): boolean {
      if (byteBudget > 0 && bytesFetched() - startBytes >= byteBudget) {
        return true;
      }
      if ((++ticks & CLOCK_MASK) !== 0) return false;
      const t = now();
      return (
        (timeMs > 0 && t - startTime >= timeMs) ||
        (stallMs > 0 && t - lastResult >= stallMs)
      );
    },
    noteResult(): void {
      lastResult = now();
    },
  };
}
