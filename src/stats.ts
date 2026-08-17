// What a search cost, gathered after the fact.
//
// The numbers already existed, scattered: `bytesFetched` and `requests` on
// three byte sources with the same names and slightly different meanings,
// `steps` on the session, the lazy DFA's state count reachable only by reading
// a private field. Answering "why was that slow" meant knowing which object to
// look at.
//
// They are *collected*, not accumulated into a shared object threaded through
// the search. The inner loops are the kernel tier — no allocation, monomorphic
// shapes — and a counter object passed into them would be a field write per
// node against a shape the loop does not otherwise touch. Every number here is
// either already kept by the component that owns it, or is a single comparison
// on push (the frontier peak). Collecting happens once, when someone asks.

/** A source that reports what it fetched. Every byte source keeps these. */
export interface SourceStats {
  bytesFetched?: number;
  requests?: number;
  chunkHits?: number;
  chunkMisses?: number;
}

/** A filter that can say how much lazy DFA it built. */
export interface FilterStats {
  /** Lazy DFA states interned so far. */
  stateCount?: number;
}

export interface Stats {
  /** Trie nodes expanded. The engine's unit of work. */
  steps: number;
  /** Results handed to the caller. */
  results: number;
  /** Largest the frontier ever got, in entries. */
  frontierPeak: number;
  /** Lazy DFA states interned across the query's conjuncts. */
  dfaStates: number;
  /** Bytes read from the index — over the wire, or off disk. */
  bytesFetched: number;
  /** Fetches or reads issued for them. */
  requests: number;
  /** Chunk cache hits and misses, where the source has a cache. */
  chunkHits: number;
  chunkMisses: number;
  /** Result predicates run, and how many survived. */
  predicateChecks: number;
  predicatePassed: number;
  /**
   * Set when the query was answered by testing a list rather than walking the
   * index (src/finite-strategy.ts): how many candidates the automaton
   * produced, and how many of those were looked up in the index.
   *
   * Without these a strategy run reported "steps: 0" and nothing else, which
   * is true and useless — the numbers that describe a walk describe none of
   * the work this does.
   */
  candidatesTested: number;
  indexLookups: number;
}

export function emptyStats(): Stats {
  return {
    steps: 0,
    results: 0,
    frontierPeak: 0,
    dfaStates: 0,
    bytesFetched: 0,
    requests: 0,
    chunkHits: 0,
    chunkMisses: 0,
    predicateChecks: 0,
    predicatePassed: 0,
    candidatesTested: 0,
    indexLookups: 0,
  };
}

/** Human-readable byte count: the numbers here span bytes to gigabytes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/**
 * One line per number that has something to say. Zeros are dropped: a
 * fully-in-memory search has no fetches, and printing ten zeros hides the two
 * numbers that matter.
 */
export function formatStats(s: Stats): string[] {
  const out: string[] = [];
  const add = (label: string, value: string) => out.push(`${label}: ${value}`);
  // A strategy run says so instead of reporting "steps: 0": the walk's units
  // describe none of what it did.
  if (s.candidatesTested) {
    add(
      "tested",
      `${s.candidatesTested.toLocaleString("en-US")} candidates, ` +
        `${s.indexLookups.toLocaleString("en-US")} looked up`,
    );
  } else {
    add("steps", s.steps.toLocaleString("en-US"));
  }
  add("results", s.results.toLocaleString("en-US"));
  if (s.frontierPeak) add("frontier peak", s.frontierPeak.toLocaleString("en-US"));
  if (s.dfaStates) add("lazy DFA states", s.dfaStates.toLocaleString("en-US"));
  if (s.requests) {
    add("fetched", `${formatBytes(s.bytesFetched)} in ${s.requests} requests`);
  }
  if (s.chunkHits || s.chunkMisses) {
    const total = s.chunkHits + s.chunkMisses;
    const pct = total === 0 ? 0 : Math.round((100 * s.chunkHits) / total);
    add("chunk cache", `${s.chunkHits}/${total} hits (${pct}%)`);
  }
  if (s.predicateChecks) {
    add("predicate", `${s.predicatePassed}/${s.predicateChecks} passed`);
  }
  return out;
}
