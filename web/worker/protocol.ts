// The page↔worker message contract.
//
// This is the only place the wire shapes are written down. The page used to
// post bare object literals, so nothing checked that what it sent matched what
// the worker destructured; importing `InMsg` on both sides makes the compiler
// the referee.
//
// Both directions are written here, and both `post` in worker.ts and the
// `onmessage` switch in main.ts go through the unions below, so a field
// renamed on one side stops compiling on the other.

import type { SessionStatus } from "../../src/search-session.js";
import type { Stats } from "../../src/stats.js";
import type { MatchReason } from "../../src/explain.js";
import type { WikiLists } from "../../src/word-lists.js";

/**
 * The page races a HEAD/Range probe against worker startup and hands over the
 * result, so the worker doesn't repeat a round trip that is already in flight.
 */
export interface EarlyProbe {
  ok: boolean;
  status: number;
  contentRange: string | null;
  contentLength: string | null;
  etag?: string | null;
  lastModified?: string | null;
}

export interface OpenMsg {
  type: "open";
  url: string;
  early?: {
    probe: EarlyProbe | null;
    table: ArrayBuffer | null;
  };
}

export interface SearchMsg {
  type: "search";
  query: string;
  /** Where to fetch the side datasets; the page resolves these. */
  phoneticsUrl?: string | null;
  thesaurusUrl?: string | null;
  neighboursUrl?: string | null;
  categoriesUrl?: string | null;
  stressUrl?: string | null;
  listsUrl?: string | null;
  /**
   * The index's head sidecar, beside the page rather than beside the index:
   * the index files are shared between deployments and this one is not.
   */
  headUrl?: string | null;
  maxSteps: number;
  maxResults: number;
  // Range mode only: stop after this many bytes fetched or ms elapsed
  // (0 = disabled). The real cost limiter remotely — steps are the ceiling.
  byteBudget?: number;
  timeMs?: number;
  /**
   * Range mode only: stop when no result has been produced for this long
   * (0 = disabled). Sent on a first run and not on a "continue", because a
   * reader who asked to keep searching has said the wait is worth it.
   */
  stallMs?: number;
}

export interface ContinueMsg {
  type: "continue";
  maxSteps: number;
  maxResults: number;
  byteBudget?: number;
  timeMs?: number;
}

export interface StopMsg {
  type: "stop";
}

export interface DownloadFullMsg {
  type: "download-full";
}

export interface CancelDownloadMsg {
  type: "cancel-download";
}

export interface RemoveCopyMsg {
  type: "remove-copy";
}

export interface OpenFileMsg {
  type: "open-file";
  file: Blob;
  name: string;
}

export interface ListCopiesMsg {
  type: "list-copies";
}

/**
 * Check a query as it is typed. Answered by the real parser, so the underline
 * in the box can never disagree with what a search would do.
 */
export interface CheckMsg {
  type: "check";
  query: string;
  /** Echoed back, so a slow answer for stale text can be discarded. */
  seq: number;
}

/** `?debug=1` asks what the query compiled to, before searching it. */
export interface PlanMsg {
  type: "plan";
  query: string;
}

/** "Why did this match?" for one result of the current query. */
export interface ExplainMsg {
  type: "explain";
  text: string;
}

/**
 * Fetch the harvested `{list:…}` catalogue for the *completion menu*, with no
 * query waiting on it.
 *
 * Until this existed the catalogue arrived only as a side effect of compiling
 * a query that used one, so typing `{list:` offered the handful of lists
 * compiled into the bundle and none of the thousand harvested ones — the menu
 * could not suggest what it had never been told about.
 */
export interface WantListsMsg {
  type: "want-lists";
  listsUrl?: string | null;
}

/**
 * Ask for `{kind:…}` completions. Answered here rather than in the page
 * because the vocabulary is 124,980 WordNet names and the page has no other
 * use for them; only the dozen matches travel.
 */
export interface CompleteKindMsg {
  type: "complete-kind";
  prefix: string;
  /** Echoed back, so a slow reply cannot overwrite a newer menu. */
  seq: number;
  categoriesUrl?: string | null;
}

/**
 * Construct packs: URLs the page found in `?pack=` and the index
 * manifest. The worker fetches, parses and installs them on its session; a
 * pack that fails to parse is reported once as a non-fatal error.
 */
export interface LoadPacksMsg {
  type: "load-packs";
  urls: string[];
}

export type InMsg =
  | LoadPacksMsg
  | OpenMsg
  | SearchMsg
  | ContinueMsg
  | StopMsg
  | DownloadFullMsg
  | CancelDownloadMsg
  | RemoveCopyMsg
  | OpenFileMsg
  | ListCopiesMsg
  | ExplainMsg
  | CheckMsg
  | PlanMsg
  | WantListsMsg
  | CompleteKindMsg;

// ---------------------------------------------------------------------------
// Outbound: worker → page.
//
// The page reads these in one `switch (msg.type)`, so they are a discriminated
// union. Before this they were bare literals on both sides, and the page cast
// its way through — `msg.lines as string[]`, `msg.stats as Stats | null`,
// `msg.status as string`. Every one of those casts was a place the two files
// could drift without the compiler noticing.

/** How the index is being read, which is most of what the page shows. */
export type IndexMode = "memory" | "disk" | "range" | "local";

/** Which engine ran, or that the answer never reached one. */
export type Engine = "js" | "wasm" | "head";

/** An interrupted whole-index download that can be resumed. */
export interface PartialDownload {
  loaded: number;
  total: number;
}

/**
 * The index is open and queries may be sent.
 *
 * Kept as one interface rather than a union over `mode`, because the worker
 * replays the last one of these verbatim (with `partial` refreshed) when a
 * download fails and the previously loaded index is still usable — and a
 * replay that had to reconstruct which variant it was holding would be a
 * worse thing than a few optional fields.
 */
export interface ReadyMsg {
  type: "ready";
  bytes: number;
  mode: IndexMode;
  total: number;
  /** Served from a cached copy rather than the network. `memory`/`disk`. */
  cached?: boolean;
  /** What "download whole index" would transfer: the sidecar, if any. `range`. */
  downloadBytes?: number;
  partial?: PartialDownload;
}

export interface LoadingMsg {
  type: "loading";
  mode: "download" | "range";
  bytes: number;
  loaded?: number;
  cached?: boolean;
}

export interface ResultMsg {
  type: "result";
  score: number;
  text: string;
  /** What a result predicate had to say about it — the compound split, say. */
  note?: string;
}

export interface ProgressMsg {
  type: "progress";
  steps: number;
  engine: Engine;
  /** Range mode only: the source's lifetime totals. */
  fetched?: number;
  requests?: number;
  /**
   * The counters so far, so a debug panel can follow a search rather than
   * waiting for it. Null on the WASM engine, which keeps only steps — the same
   * rule as `DoneMsg.stats`.
   */
  stats: Stats | null;
}

export interface DoneMsg {
  type: "done";
  status: SessionStatus;
  /** The parts of an impossible query that disagree; null when it is not one. */
  conflict: string[] | null;
  steps: number;
  /** Only the JS engine keeps these; the kernel reports steps and no more. */
  stats: Stats | null;
  engine: Engine;
  fetched?: number;
  requests?: number;
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

/** A download failed or was cancelled; the index itself may still be usable. */
export interface DownloadErrorMsg {
  type: "download-error";
  message: string;
}

export interface ParseErrorMsg {
  type: "parse-error";
  /** The tail of the query that would not parse. */
  rest: string;
  /** What a recognised-but-wrong construct had to say for itself. */
  detail?: string;
}

export interface CopiesMsg {
  type: "copies";
  urls: string[];
}

/** Where in the query text something went wrong, and what. */
export interface QueryFault {
  detail: string;
  /** Offset into the query the fault starts at. */
  at: number;
}

export interface CheckedMsg {
  type: "checked";
  /** Echoed, so a slow answer cannot overwrite a newer one. */
  seq: number;
  error: QueryFault | null;
}

export interface KindCompletionsMsg {
  type: "kind-completions";
  seq: number;
  items: string[];
}

export interface ListsReadyMsg {
  type: "lists-ready";
  lists: WikiLists;
}

export interface PlannedMsg {
  type: "planned";
  lines: string[];
}

export interface ExplanationMsg {
  type: "explanation";
  /** Echoed: the page finds the result box this belongs to by its text. */
  text: string;
  reasons: MatchReason[];
}

export type OutMsg =
  | ReadyMsg
  | LoadingMsg
  | ResultMsg
  | ProgressMsg
  | DoneMsg
  | ErrorMsg
  | DownloadErrorMsg
  | ParseErrorMsg
  | CopiesMsg
  | CheckedMsg
  | KindCompletionsMsg
  | ListsReadyMsg
  | PlannedMsg
  | ExplanationMsg;
