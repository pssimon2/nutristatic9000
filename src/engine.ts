// The public surface (F8): what an embedder — an MCP server, a solving
// script, another UI — may import. Everything else under src/ is internal
// and free to change without notice.
//
// The shape of a session:
//
//   import {
//     IndexReader, MemorySource, SessionContext, SearchSession,
//   } from "nutristatic9000/engine";
//
//   const reader = await IndexReader.open(new MemorySource(bytes));
//   const ctx = new SessionContext();            // + datasets, packs, lists
//   const { specs, inner } = parseFilterWrappers(query);
//   const session = new SearchSession(reader, inner, ctx);
//   await session.run(1e6, 100, async (r) => {
//     const v = await applyResultFilters(specs, r.text, ctx, isWord);
//     if (v.keep) show(r);
//   });
//
// The CLI (cli/find-expr.ts) is the reference consumer: everything it does,
// it does through these names.

// Query language: peel, compile, plan, explain.
export {
  ParseError,
  compileConjuncts,
  compileQuery,
  formatScore,
  makeDriver,
} from "./find-expr.js";
export {
  FilterError,
  type FilterSpec,
  parseFilterWrappers,
} from "./result-filter.js";
export { formatPlan, planQuery, type QueryPlan } from "./plan.js";
export { shapeOfQuery, type QueryShape } from "./query-shape.js";
export { derivedNote } from "./match-notes.js";

// The catalogue: names, levels, groups, docs.
export {
  CONSTRUCTS,
  type ConstructInfo,
  namesAtLevel,
  namesInGroup,
} from "./constructs.js";
export { type Completion, completionsAt } from "./complete.js";

// Session state: datasets, remote lists, construct packs.
export { type DataKey, SessionContext } from "./session-context.js";
export { DATA_PROVIDERS, providersFor } from "./data-providers.js";
export { parseRemoteList, remoteListUrls } from "./word-lists.js";
export { type ConstructPack, installPack, parsePack } from "./packs.js";
export {
  type IndexManifest,
  parseManifest,
  transliterateQuery,
} from "./manifest.js";

// Reading an index: byte sources for memory, disk and HTTP Range.
export {
  type ByteSource,
  HttpRangeSource,
  MemorySource,
} from "./byte-source.js";
export { CompressedRangeSource } from "./compressed-source.js";
export { IndexReader } from "./index-reader.js";
export { makeWordChecker } from "./index-words.js";

// Running a search.
export {
  SearchSession,
  type SearchResult,
  type SessionStatus,
} from "./search-session.js";
export { SearchDriver, type SearchDriverOptions } from "./search-driver.js";
export { MergedDriver, type MergedSource } from "./merged-driver.js";
export { type Filter, FilterCache } from "./expr-filter.js";

// Deciding a finished match.
export {
  applyResultFilter,
  applyResultFilters,
  type FiltersVerdict,
} from "./result-predicate.js";
