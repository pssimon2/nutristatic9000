// The page↔worker message contract.
//
// This is the only place the wire shapes are written down. The page used to
// post bare object literals, so nothing checked that what it sent matched what
// the worker destructured; importing `InMsg` on both sides makes the compiler
// the referee.
//
// Outbound (worker→page) messages are still posted untyped — see the note on
// `post` in worker.ts. Typing them is a separate change, because it has to
// account for the UI's `postReady` replay.

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
  maxSteps: number;
  maxResults: number;
  // Range mode only: stop after this many bytes fetched or ms elapsed
  // (0 = disabled). The real cost limiter remotely — steps are the ceiling.
  byteBudget?: number;
  timeMs?: number;
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

export type InMsg =
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
