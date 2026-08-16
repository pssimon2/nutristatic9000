// Everything a query needs beyond the index and the pattern itself.
//
// The side datasets used to live as module-level `let loaded` singletons with
// setX/xLoaded accessors, which meant a process had exactly one of each: two
// sessions could not hold different data, and tests had to care about load
// order because one file's setX leaked into the next. They are now fields on a
// context that the caller owns and threads through compilation.
//
// The datasets are plain fields rather than accessors: loading is the host's
// job (the worker fetches, the CLI reads files, tests assign directly), and
// the engine only ever reads. A null field means "not loaded" — the parser
// turns that into a ParseError naming the construct that needed it.

import { Categories } from "./categories.js";
import { Neighbours } from "./neighbours.js";
import { Phonetics } from "./phonetics.js";
import { Stress } from "./stress.js";
import { Thesaurus } from "./thesaurus.js";

/**
 * The side data a compilation may consult. Construct one per session; share it
 * freely between queries of that session, since nothing here is mutated during
 * a search.
 *
 * Not included: the built-in word lists (`word-lists.ts`), whose cache memoizes
 * a compile-time constant and so is identical in every context. Per-session
 * lists arrive with remote lists (F3), and belong here when they do.
 */
export class SessionContext {
  phonetics: Phonetics | null = null;
  stress: Stress | null = null;
  categories: Categories | null = null;
  neighbours: Neighbours | null = null;
  thesaurus: Thesaurus | null = null;
}

/** The datasets a query needs, as reported by the `needsX` sniffers. */
export type DataKey = keyof SessionContext;
